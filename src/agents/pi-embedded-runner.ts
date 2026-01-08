import fs from "node:fs/promises";
import os from "node:os";

import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type { ClawdbotConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { createSubsystemLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  type enqueueCommand,
  enqueueCommandInLane,
} from "../process/command-queue.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import type { BashElevatedDefaults } from "./bash-tools.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  getApiKeyForModel,
  markAntigravityAccountRateLimited,
} from "./model-auth.js";
import { ensureClawdbotModelsJson } from "./models-config.js";
import {
  buildBootstrapContextFiles,
  ensureSessionHeader,
  formatAssistantErrorText,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";
import {
  type BlockReplyChunking,
  subscribeEmbeddedPiSession,
} from "./pi-embedded-subscribe.js";
import { extractAssistantText } from "./pi-embedded-utils.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createClawdbotCodingTools } from "./pi-tools.js";
import { resolveSandboxContext } from "./sandbox.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
  type SkillEntry,
  type SkillSnapshot,
} from "./skills.js";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
  }>;
  meta: EmbeddedPiRunMeta;
};

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  abort: () => void;
  requestCompaction: (customInstructions?: string) => void;
  getCompactionResult: () => {
    requested: boolean;
    result?: { success: boolean; summary?: string; error?: string };
  };
};

const log = createSubsystemLogger("agent/embedded");

// Activity timeout for Antigravity silent rate-limits (30 seconds)
const ANTIGRAVITY_ACTIVITY_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_ACTIVITY_CHECK_INTERVAL_MS = 5_000;
const ANTIGRAVITY_MAX_RETRIES = 3;

// Custom error for activity timeout (triggers retry with different account)
class AntigravityActivityTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityActivityTimeoutError";
  }
}

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  browserControlUrl?: string;
  browserNoVncUrl?: string;
};

function resolveSessionLane(key: string) {
  const cleaned = key.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) return undefined;
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    browserControlUrl: sandbox.browser?.controlUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
  };
}

export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  if (!handle.isStreaming()) return false;
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  handle.abort();
  return true;
}

export async function compactEmbeddedPiSession(
  sessionId: string,
  customInstructions?: string,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return { success: false, error: "No active session found" };
  }
  handle.requestCompaction(customInstructions);
  return {
    success: true,
    summary: "Compaction scheduled for after current response",
  };
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId);
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  return handle.isStreaming();
}

export function waitForEmbeddedPiRunEnd(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId))
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) return;
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh" too; Clawdbot doesn't surface it for now.
  if (!level) return "off";
  return level;
}

function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model, authStorage, modelRegistry };
}

function resolvePromptSkills(
  snapshot: SkillSnapshot,
  entries: SkillEntry[],
): Skill[] {
  if (snapshot.resolvedSkills?.length) {
    return snapshot.resolvedSkills;
  }

  const snapshotNames = snapshot.skills.map((entry) => entry.name);
  if (snapshotNames.length === 0) return [];

  const entryByName = new Map(
    entries.map((entry) => [entry.skill.name, entry.skill]),
  );
  return snapshotNames
    .map((name) => entryByName.get(name))
    .filter((skill): skill is Skill => Boolean(skill));
}

export async function runEmbeddedPiAgent(params: {
  sessionId: string;
  sessionKey?: string;
  surface?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  bashElevated?: BashElevatedDefaults;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
}): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      await ensureClawdbotModelsJson(params.config);
      const agentDir = resolveClawdbotAgentDir();
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }
      const apiKey = await getApiKeyForModel(model, authStorage);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      const thinkingLevel = mapThinkingLevel(params.thinkLevel);

      log.debug(
        `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${provider} model=${modelId} surface=${params.surface ?? "unknown"}`,
      );

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: resolvedWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(resolvedWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(resolvedWorkspace)
          : [];
        const skillsSnapshot =
          params.skillsSnapshot ??
          buildWorkspaceSkillSnapshot(resolvedWorkspace, {
            config: params.config,
            entries: skillEntries,
          });
        const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
        const sandbox = await resolveSandboxContext({
          config: params.config,
          sessionKey: sandboxSessionKey,
          workspaceDir: resolvedWorkspace,
        });
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });

        const bootstrapFiles =
          await loadWorkspaceBootstrapFiles(resolvedWorkspace);
        const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
        const promptSkills = resolvePromptSkills(skillsSnapshot, skillEntries);
        // Tool schemas must be provider-compatible (OpenAI requires top-level `type: "object"`).
        // `createClawdbotCodingTools()` normalizes schemas so the session can pass them through unchanged.
        const tools = createClawdbotCodingTools({
          bash: {
            ...params.config?.agent?.bash,
            elevated: params.bashElevated,
          },
          sandbox,
          surface: params.surface,
          sessionKey: params.sessionKey ?? params.sessionId,
          sessionId: params.sessionId,
          config: params.config,
        });
        const machineName = await getMachineDisplayName();
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
        };
        const sandboxInfo = buildEmbeddedSandboxInfo(sandbox);
        const reasoningTagHint = provider === "ollama";
        const systemPrompt = buildSystemPrompt({
          appendPrompt: buildAgentSystemPromptAppend({
            workspaceDir: resolvedWorkspace,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: params.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            runtimeInfo,
            sandboxInfo,
            toolNames: tools.map((tool) => tool.name),
          }),
          contextFiles,
          skills: promptSkills,
          cwd: resolvedWorkspace,
          tools,
        });

        const sessionManager = SessionManager.open(params.sessionFile);
        const settingsManager = SettingsManager.create(
          resolvedWorkspace,
          agentDir,
        );

        // Split tools into built-in (recognized by pi-coding-agent SDK) and custom (clawdbot-specific)
        const builtInToolNames = new Set(["read", "bash", "edit", "write"]);
        const builtInTools = tools.filter((t) => builtInToolNames.has(t.name));
        const customTools = toToolDefinitions(
          tools.filter((t) => !builtInToolNames.has(t.name)),
        );

        // Retry loop for Antigravity silent rate-limits
        const isAntigravityProvider = provider === "google-antigravity";
        const maxRetries = isAntigravityProvider ? ANTIGRAVITY_MAX_RETRIES : 1;
        let lastRetryError: unknown = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Refresh API key for each attempt (picks different account after rate-limit marking)
            if (attempt > 0) {
              log.info(
                `embedded run retry attempt ${attempt + 1}/${maxRetries}: runId=${params.runId} sessionId=${params.sessionId}`,
              );
              const freshApiKey = await getApiKeyForModel(model, authStorage);
              authStorage.setRuntimeApiKey(model.provider, freshApiKey);
            }

            const { session } = await createAgentSession({
              cwd: resolvedWorkspace,
              agentDir,
              authStorage,
              modelRegistry,
              model,
              thinkingLevel,
              systemPrompt,
              // Built-in tools recognized by pi-coding-agent SDK
              tools: builtInTools,
              // Custom clawdbot tools (browser, canvas, nodes, cron, etc.)
              customTools,
              sessionManager,
              settingsManager,
              skills: promptSkills,
              contextFiles,
            });

            const prior = await sanitizeSessionMessagesImages(
              session.messages,
              "session:history",
            );
            if (prior.length > 0) {
              session.agent.replaceMessages(prior);
            }
            let aborted = Boolean(params.abortSignal?.aborted);
            let pendingCompaction: {
              requested: boolean;
              instructions?: string;
              result?: { success: boolean; summary?: string; error?: string };
            } = { requested: false };
            const abortRun = () => {
              aborted = true;
              void session.abort();
            };
            const queueHandle: EmbeddedPiQueueHandle = {
              queueMessage: async (text: string) => {
                await session.steer(text);
              },
              isStreaming: () => session.isStreaming,
              abort: abortRun,
              requestCompaction: (customInstructions?: string) => {
                pendingCompaction = {
                  requested: true,
                  instructions: customInstructions,
                };
              },
              getCompactionResult: () => ({
                requested: pendingCompaction.requested,
                result: pendingCompaction.result,
              }),
            };
            ACTIVE_EMBEDDED_RUNS.set(params.sessionId, queueHandle);

            // Activity tracking for Antigravity silent rate-limit detection
            let lastActivityAt = Date.now();
            let activityTimeoutError: AntigravityActivityTimeoutError | null = null;
            const isAntigravity = provider === "google-antigravity";

            const {
              assistantTexts,
              toolMetas,
              unsubscribe,
              waitForCompactionRetry,
            } = subscribeEmbeddedPiSession({
              session,
              runId: params.runId,
              verboseLevel: params.verboseLevel,
              shouldEmitToolResult: params.shouldEmitToolResult,
              onToolResult: params.onToolResult,
              onBlockReply: params.onBlockReply,
              blockReplyBreak: params.blockReplyBreak,
              blockReplyChunking: params.blockReplyChunking,
              onPartialReply: params.onPartialReply,
              onAgentEvent: params.onAgentEvent,
              enforceFinalTag: params.enforceFinalTag,
              onActivity: () => {
                lastActivityAt = Date.now();
              },
            });

            // Activity timeout checker for Antigravity (detects silent rate-limits)
            let activityChecker: NodeJS.Timeout | undefined;
            if (isAntigravity) {
              activityChecker = setInterval(() => {
                const timeSinceActivity = Date.now() - lastActivityAt;
                if (timeSinceActivity > ANTIGRAVITY_ACTIVITY_TIMEOUT_MS) {
                  log.warn(
                    `embedded run no activity for ${timeSinceActivity}ms, aborting: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                  activityTimeoutError = new AntigravityActivityTimeoutError(
                    `No streaming activity for ${Math.round(
                      timeSinceActivity / 1000,
                    )}s - likely silent rate-limit`,
                  );
                  abortRun();
                }
              }, ANTIGRAVITY_ACTIVITY_CHECK_INTERVAL_MS);
            }

            let abortWarnTimer: NodeJS.Timeout | undefined;
            const abortTimer = setTimeout(
              () => {
                log.warn(
                  `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
                );
                abortRun();
                if (!abortWarnTimer) {
                  abortWarnTimer = setTimeout(() => {
                    if (!session.isStreaming) return;
                    log.warn(
                      `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                    );
                  }, 10_000);
                }
              },
              Math.max(1, params.timeoutMs),
            );

            let messagesSnapshot: AgentMessage[] = [];
            let sessionIdUsed = session.sessionId;
            const onAbort = () => {
              abortRun();
            };
            if (params.abortSignal) {
              if (params.abortSignal.aborted) {
                onAbort();
              } else {
                params.abortSignal.addEventListener("abort", onAbort, {
                  once: true,
                });
              }
            }
            let promptError: unknown = null;
            try {
              const promptStartedAt = Date.now();
              log.debug(
                `embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`,
              );
              try {
                await session.prompt(params.prompt);
              } catch (err) {
                promptError = err;
              } finally {
                log.debug(
                  `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
                );
              }
              await waitForCompactionRetry();

              if (pendingCompaction.requested && !aborted) {
                try {
                  log.debug(
                    `embedded run deferred compaction start: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                  const compactResult = await session.compact(
                    pendingCompaction.instructions,
                  );
                  pendingCompaction.result = {
                    success: true,
                    summary: compactResult.summary,
                  };
                  log.debug(
                    `embedded run deferred compaction done: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                } catch (err) {
                  pendingCompaction.result = {
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                  };
                  log.warn(
                    `embedded run deferred compaction failed: runId=${params.runId} sessionId=${params.sessionId} error=${pendingCompaction.result.error}`,
                  );
                }
              }

              messagesSnapshot = session.messages.slice();
              sessionIdUsed = session.sessionId;
            } finally {
              clearTimeout(abortTimer);
              if (abortWarnTimer) {
                clearTimeout(abortWarnTimer);
                abortWarnTimer = undefined;
              }
              if (activityChecker) {
                clearInterval(activityChecker);
                activityChecker = undefined;
              }
              unsubscribe();
              if (ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === queueHandle) {
                ACTIVE_EMBEDDED_RUNS.delete(params.sessionId);
                notifyEmbeddedRunEnded(params.sessionId);
              }
              session.dispose();
              params.abortSignal?.removeEventListener?.("abort", onAbort);
            }

            // Check for activity timeout error first (triggers retry with different account)
            if (activityTimeoutError) {
              await markAntigravityAccountRateLimited(modelId, 120000);
              throw activityTimeoutError;
            }

            if (promptError && !aborted) {
              if (provider === "google-antigravity") {
                const errorMsg =
                  promptError instanceof Error
                    ? promptError.message
                    : String(promptError);
                const isRateLimitError =
                  errorMsg.includes("429") ||
                  errorMsg.includes("rate") ||
                  errorMsg.includes("quota") ||
                  errorMsg.includes("limit") ||
                  errorMsg.includes("timeout") ||
                  errorMsg.includes("ECONNRESET") ||
                  errorMsg.includes("ETIMEDOUT");
                if (isRateLimitError) {
                  log.warn(
                    `embedded run marking antigravity account as rate-limited: ${errorMsg}`,
                  );
                  await markAntigravityAccountRateLimited(modelId, 120000);
                }
              }
              throw promptError;
            }

            const lastAssistant = messagesSnapshot
              .slice()
              .reverse()
              .find((m) => (m as AgentMessage)?.role === "assistant") as
              | AssistantMessage
              | undefined;

            const usage = lastAssistant?.usage;
            const agentMeta: EmbeddedPiAgentMeta = {
              sessionId: sessionIdUsed,
              provider: lastAssistant?.provider ?? provider,
              model: lastAssistant?.model ?? model.id,
              usage: usage
                ? {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    total: usage.totalTokens,
                  }
                : undefined,
            };

            const replyItems: Array<{ text: string; media?: string[] }> = [];

            const errorText = lastAssistant
              ? formatAssistantErrorText(lastAssistant)
              : undefined;
            if (errorText) replyItems.push({ text: errorText });

            const inlineToolResults =
              params.verboseLevel === "on" &&
              !params.onPartialReply &&
              !params.onToolResult &&
              toolMetas.length > 0;
            if (inlineToolResults) {
              for (const { toolName, meta } of toolMetas) {
                const agg = formatToolAggregate(toolName, meta ? [meta] : []);
                const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
                if (cleanedText)
                  replyItems.push({ text: cleanedText, media: mediaUrls });
              }
            }

            for (const text of assistantTexts.length
              ? assistantTexts
              : lastAssistant
                ? [extractAssistantText(lastAssistant)]
                : []) {
              const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
              if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) continue;
              replyItems.push({ text: cleanedText, media: mediaUrls });
            }

            const payloads = replyItems
              .map((item) => ({
                text: item.text?.trim() ? item.text.trim() : undefined,
                mediaUrls: item.media?.length ? item.media : undefined,
                mediaUrl: item.media?.[0],
              }))
              .filter(
                (p) =>
                  p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
              );

            log.debug(
              `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
            );
            return {
              payloads: payloads.length ? payloads : undefined,
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
              },
            };
          } catch (err) {
            // Only retry for activity timeout errors (silent rate-limits)
            const isRetryable = err instanceof AntigravityActivityTimeoutError;
            const hasMoreAttempts = attempt < maxRetries - 1;

            if (isRetryable && hasMoreAttempts) {
              log.warn(
                `embedded run activity timeout, will retry: runId=${params.runId} attempt=${attempt + 1}/${maxRetries}`,
              );
              lastRetryError = err;
              continue;
            }

            // Non-retryable error or no more attempts - rethrow
            throw err;
          }
        }

        // Should not reach here if loop completed normally (returns inside loop)
        // This handles the case where all retries failed
        throw lastRetryError ?? new Error("All Antigravity retry attempts exhausted");
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}
