import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type Api,
  getEnvApiKey,
  getOAuthApiKey,
  type Model,
  type OAuthCredentials,
  type OAuthProvider,
  refreshAntigravityToken,
} from "@mariozechner/pi-ai";
import type { discoverAuthStorage } from "@mariozechner/pi-coding-agent";

import { logDebug, logError, logInfo } from "../logger.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  AntigravityAccountManager,
  getAntigravityAccountManager,
  getModelFamily,
  loadAccountStorage,
  type ManagedAccount,
} from "./antigravity-accounts.js";

const OAUTH_FILENAME = "oauth.json";
const DEFAULT_OAUTH_DIR = path.join(CONFIG_DIR, "credentials");
let oauthStorageConfigured = false;
let oauthStorageMigrated = false;

type OAuthStorage = Record<string, OAuthCredentials>;

function resolveClawdbotOAuthPath(): string {
  const overrideDir =
    process.env.CLAWDBOT_OAUTH_DIR?.trim() || DEFAULT_OAUTH_DIR;
  return path.join(resolveUserPath(overrideDir), OAUTH_FILENAME);
}

function loadOAuthStorageAt(pathname: string): OAuthStorage | null {
  if (!fsSync.existsSync(pathname)) return null;
  try {
    const content = fsSync.readFileSync(pathname, "utf8");
    const json = JSON.parse(content) as OAuthStorage;
    if (!json || typeof json !== "object") return null;
    return json;
  } catch {
    return null;
  }
}

function hasAnthropicOAuth(storage: OAuthStorage): boolean {
  const entry = storage.anthropic as
    | {
        refresh?: string;
        refresh_token?: string;
        refreshToken?: string;
        access?: string;
        access_token?: string;
        accessToken?: string;
      }
    | undefined;
  if (!entry) return false;
  const refresh =
    entry.refresh ?? entry.refresh_token ?? entry.refreshToken ?? "";
  const access = entry.access ?? entry.access_token ?? entry.accessToken ?? "";
  return Boolean(refresh.trim() && access.trim());
}

function saveOAuthStorageAt(pathname: string, storage: OAuthStorage): void {
  const dir = path.dirname(pathname);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(
    pathname,
    `${JSON.stringify(storage, null, 2)}\n`,
    "utf8",
  );
  fsSync.chmodSync(pathname, 0o600);
}

function legacyOAuthPaths(): string[] {
  const paths: string[] = [];
  const piOverride = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piOverride) {
    paths.push(path.join(resolveUserPath(piOverride), OAUTH_FILENAME));
  }
  paths.push(path.join(os.homedir(), ".pi", "agent", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "anthropic", OAUTH_FILENAME));
  return Array.from(new Set(paths));
}

function importLegacyOAuthIfNeeded(destPath: string): void {
  if (fsSync.existsSync(destPath)) return;
  for (const legacyPath of legacyOAuthPaths()) {
    const storage = loadOAuthStorageAt(legacyPath);
    if (!storage || !hasAnthropicOAuth(storage)) continue;
    saveOAuthStorageAt(destPath, storage);
    return;
  }
}

export function ensureOAuthStorage(): void {
  if (oauthStorageConfigured) return;
  oauthStorageConfigured = true;
  const oauthPath = resolveClawdbotOAuthPath();
  importLegacyOAuthIfNeeded(oauthPath);
}

function isValidOAuthCredential(
  entry: OAuthCredentials | undefined,
): entry is OAuthCredentials {
  if (!entry) return false;
  return Boolean(
    entry.access?.trim() &&
      entry.refresh?.trim() &&
      Number.isFinite(entry.expires),
  );
}

function migrateOAuthStorageToAuthStorage(
  authStorage: ReturnType<typeof discoverAuthStorage>,
): void {
  if (oauthStorageMigrated) return;
  oauthStorageMigrated = true;
  const oauthPath = resolveClawdbotOAuthPath();
  const storage = loadOAuthStorageAt(oauthPath);
  if (!storage) return;
  for (const [provider, creds] of Object.entries(storage)) {
    if (!isValidOAuthCredential(creds)) continue;
    if (authStorage.get(provider)) continue;
    authStorage.set(provider, { type: "oauth", ...creds });
  }
}

export function hydrateAuthStorage(
  authStorage: ReturnType<typeof discoverAuthStorage>,
): void {
  ensureOAuthStorage();
  migrateOAuthStorageToAuthStorage(authStorage);
}

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return (
    provider === "anthropic" ||
    provider === "anthropic-oauth" ||
    provider === "google" ||
    provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "openai-codex" ||
    provider === "github-copilot" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  );
}

const TOKEN_REFRESH_TIMEOUT_MS = 15000; // 15 seconds

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms),
    ),
  ]);
}

async function refreshAccountToken(
  account: ManagedAccount,
): Promise<{ access: string; expires: number } | null> {
  if (!account.refreshToken || !account.projectId) {
    logError(
      `antigravity: Cannot refresh token: missing ${!account.refreshToken ? "refreshToken" : "projectId"} for account ${account.email ?? account.index}`,
    );
    return null;
  }
  try {
    logInfo(
      `antigravity: Refreshing token for account ${account.email ?? account.index} (project: ${account.projectId})`,
    );
    const result = await withTimeout(
      refreshAntigravityToken(account.refreshToken, account.projectId),
      TOKEN_REFRESH_TIMEOUT_MS,
      `Token refresh timed out after ${TOKEN_REFRESH_TIMEOUT_MS / 1000}s`,
    );
    if (result?.access) {
      logInfo(
        `antigravity: Token refreshed successfully for ${account.email ?? account.index}, expires: ${new Date(result.expires).toISOString()}`,
      );
      return { access: result.access, expires: result.expires };
    }
    logError(
      `antigravity: Token refresh returned no access token for ${account.email ?? account.index}`,
    );
  } catch (error) {
    logError(
      `antigravity: Token refresh failed for ${account.email ?? account.index}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
  return null;
}

interface AntigravityAccountResult {
  access: string;
  refreshToken: string;
  projectId: string;
  expires: number;
}

async function getAntigravityApiKeyWithAccount(
  modelId: string,
): Promise<AntigravityAccountResult | null> {
  logDebug(`antigravity: getAntigravityApiKey called for model: ${modelId}`);
  const multiAccountStorage = await loadAccountStorage();

  if (!multiAccountStorage || multiAccountStorage.accounts.length === 0) {
    logDebug(
      "antigravity: No multi-account storage found, checking legacy oauth.json",
    );
    const oauthPath = resolveClawdbotOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    const antigravityCreds = storage?.["google-antigravity"];

    if (!antigravityCreds?.refresh || !antigravityCreds?.projectId) {
      return null;
    }

    const manager = await getAntigravityAccountManager(
      antigravityCreds.refresh,
      antigravityCreds.projectId,
      antigravityCreds.access,
      antigravityCreds.expires,
    );
    return getAccountResultFromManager(manager, modelId);
  }

  logInfo(
    `antigravity: Found ${multiAccountStorage.accounts.length} accounts in storage`,
  );
  const manager = await getAntigravityAccountManager();
  return getAccountResultFromManager(manager, modelId);
}

async function getAccountResultFromManager(
  manager: AntigravityAccountManager,
  modelId: string,
): Promise<AntigravityAccountResult | null> {
  const family = getModelFamily(modelId);
  const selectionMode =
    manager.getAccountCount() > 1 ? "round-robin" : "sticky";
  logInfo(
    `antigravity: Selecting account for ${family} (mode: ${selectionMode})`,
  );
  const account = manager.selectAccountForFamily(family, selectionMode);

  if (!account) {
    const waitTime = manager.getMinWaitTimeForFamily(family);
    if (waitTime > 0) {
      throw new Error(
        `All Antigravity accounts rate-limited for ${family}. Retry in ${Math.ceil(waitTime / 1000)}s`,
      );
    }
    logError(`antigravity: No account available for model family ${family}`);
    return null;
  }

  if (!account.projectId) {
    logError(
      `antigravity: Account ${account.email ?? account.index} has no projectId`,
    );
    return null;
  }

  logInfo(
    `antigravity: Selected account ${account.email ?? account.index} for ${family}`,
  );

  const now = Date.now();
  const tokenExpired =
    !account.access || (account.expires && now >= account.expires);

  if (tokenExpired) {
    logInfo(
      `antigravity: Token expired or missing for ${account.email ?? account.index}, refreshing...`,
    );
    const refreshed = await refreshAccountToken(account);
    if (refreshed) {
      manager.updateAccount(account, refreshed.access, refreshed.expires);
      await manager.save();
      return {
        access: refreshed.access,
        refreshToken: account.refreshToken,
        projectId: account.projectId,
        expires: refreshed.expires,
      };
    }

    logError(
      `antigravity: Failed to refresh token for ${account.email ?? account.index}, trying next account...`,
    );
    manager.markRateLimited(account, 60000, family);

    const nextAccount = manager.selectAccountForFamily(family, selectionMode);
    if (
      nextAccount &&
      nextAccount.index !== account.index &&
      nextAccount.projectId
    ) {
      logInfo(
        `antigravity: Trying next account: ${nextAccount.email ?? nextAccount.index}`,
      );
      const nextRefreshed = await refreshAccountToken(nextAccount);
      if (nextRefreshed) {
        manager.updateAccount(
          nextAccount,
          nextRefreshed.access,
          nextRefreshed.expires,
        );
        await manager.save();
        return {
          access: nextRefreshed.access,
          refreshToken: nextAccount.refreshToken,
          projectId: nextAccount.projectId,
          expires: nextRefreshed.expires,
        };
      }
    }

    throw new Error(
      `Failed to refresh Antigravity token for account ${account.email ?? account.index}. Please re-authenticate with 'clawdbot antigravity accounts add'`,
    );
  }

  await manager.save();
  const token = account.access ?? null;
  logInfo(
    `antigravity: Returning token for ${account.email ?? account.index}: ${token ? `${token.slice(0, 20)}...` : "NULL"}`,
  );

  if (!token) {
    return null;
  }

  return {
    access: token,
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    expires: account.expires ?? 0,
  };
}

async function getAntigravityApiKey(modelId: string): Promise<string | null> {
  logDebug(`antigravity: getAntigravityApiKey called for model: ${modelId}`);
  const multiAccountStorage = await loadAccountStorage();

  if (!multiAccountStorage || multiAccountStorage.accounts.length === 0) {
    logDebug(
      "antigravity: No multi-account storage found, checking legacy oauth.json",
    );
    const oauthPath = resolveClawdbotOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    const antigravityCreds = storage?.["google-antigravity"];

    if (!antigravityCreds?.refresh) {
      return null;
    }

    const manager = await getAntigravityAccountManager(
      antigravityCreds.refresh,
      antigravityCreds.projectId,
      antigravityCreds.access,
      antigravityCreds.expires,
    );
    return getApiKeyFromManager(manager, modelId);
  }

  logInfo(
    `antigravity: Found ${multiAccountStorage.accounts.length} accounts in storage`,
  );
  const manager = await getAntigravityAccountManager();
  return getApiKeyFromManager(manager, modelId);
}

async function getApiKeyFromManager(
  manager: AntigravityAccountManager,
  modelId: string,
): Promise<string | null> {
  const family = getModelFamily(modelId);
  const selectionMode =
    manager.getAccountCount() > 1 ? "round-robin" : "sticky";
  logInfo(
    `antigravity: Selecting account for ${family} (mode: ${selectionMode})`,
  );
  const account = manager.selectAccountForFamily(family, selectionMode);

  if (!account) {
    const waitTime = manager.getMinWaitTimeForFamily(family);
    if (waitTime > 0) {
      throw new Error(
        `All Antigravity accounts rate-limited for ${family}. Retry in ${Math.ceil(waitTime / 1000)}s`,
      );
    }
    logError(`antigravity: No account available for model family ${family}`);
    return null;
  }

  logInfo(
    `antigravity: Selected account ${account.email ?? account.index} for ${family}`,
  );

  const now = Date.now();
  const tokenExpired =
    !account.access || (account.expires && now >= account.expires);

  if (tokenExpired) {
    logInfo(
      `antigravity: Token expired or missing for ${account.email ?? account.index}, refreshing...`,
    );
    const refreshed = await refreshAccountToken(account);
    if (refreshed) {
      manager.updateAccount(account, refreshed.access, refreshed.expires);
      await manager.save();
    } else {
      logError(
        `antigravity: Failed to refresh token for ${account.email ?? account.index}, trying next account...`,
      );
      // Mark this account as temporarily rate-limited to try the next one
      manager.markRateLimited(account, 60000, family); // 1 minute cooldown

      // Try to get another account
      const nextAccount = manager.selectAccountForFamily(family, selectionMode);
      if (nextAccount && nextAccount.index !== account.index) {
        logInfo(
          `antigravity: Trying next account: ${nextAccount.email ?? nextAccount.index}`,
        );
        const nextRefreshed = await refreshAccountToken(nextAccount);
        if (nextRefreshed) {
          manager.updateAccount(
            nextAccount,
            nextRefreshed.access,
            nextRefreshed.expires,
          );
          await manager.save();
          return nextAccount.access ?? null;
        }
      }

      throw new Error(
        `Failed to refresh Antigravity token for account ${account.email ?? account.index}. Please re-authenticate with 'clawdbot antigravity accounts add'`,
      );
    }
  }

  await manager.save();
  const token = account.access ?? null;
  logInfo(
    `antigravity: Returning token for ${account.email ?? account.index}: ${token ? `${token.slice(0, 20)}...` : "NULL"}`,
  );
  return token;
}

export async function getApiKeyForModel(
  model: Model<Api>,
  authStorage: ReturnType<typeof discoverAuthStorage>,
): Promise<string> {
  ensureOAuthStorage();
  migrateOAuthStorageToAuthStorage(authStorage);

  // For Antigravity, prioritize multi-account storage over legacy auth storage
  if (model.provider === "google-antigravity") {
    const result = await getAntigravityApiKeyWithAccount(model.id);
    if (result) {
      // Set full OAuth credentials so pi-ai has everything it needs
      authStorage.set(model.provider, {
        type: "oauth",
        access: result.access,
        refresh: result.refreshToken,
        expires: result.expires,
        projectId: result.projectId,
      });
      // pi-ai expects JSON: { token, projectId }
      return JSON.stringify({
        token: result.access,
        projectId: result.projectId,
      });
    }
    // Fall through to try legacy auth storage if multi-account fails
  }

  const storedKey = await authStorage.getApiKey(model.provider);
  if (storedKey) return storedKey;
  if (model.provider === "anthropic") {
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
    if (oauthEnv?.trim()) return oauthEnv.trim();
  }
  const envKey = getEnvApiKey(model.provider);
  if (envKey) return envKey;

  if (isOAuthProvider(model.provider)) {
    const oauthPath = resolveClawdbotOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    if (storage) {
      try {
        const result = await getOAuthApiKey(model.provider, storage);
        if (result?.apiKey) {
          storage[model.provider] = result.newCredentials;
          saveOAuthStorageAt(oauthPath, storage);
          return result.apiKey;
        }
      } catch {
        // fall through to error below
      }
    }
  }
  throw new Error(`No API key found for provider "${model.provider}"`);
}

export async function markAntigravityAccountRateLimited(
  modelId: string,
  durationMs = 60000,
): Promise<boolean> {
  const multiAccountStorage = await loadAccountStorage();
  if (!multiAccountStorage || multiAccountStorage.accounts.length === 0) {
    return false;
  }

  const manager = await getAntigravityAccountManager();
  const family = getModelFamily(modelId);
  const activeIndex = multiAccountStorage.activeIndex ?? 0;
  const accountData = multiAccountStorage.accounts[activeIndex];

  if (!accountData) {
    return false;
  }

  const account: ManagedAccount = {
    ...accountData,
    index: activeIndex,
    rateLimitResetTimes: accountData.rateLimitResetTimes ?? {},
  };

  logInfo(
    `antigravity: Marking account ${account.email ?? activeIndex} as rate-limited for ${durationMs}ms`,
  );
  manager.markRateLimited(account, durationMs, family);
  await manager.save();
  return true;
}
