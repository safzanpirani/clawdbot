import chalk from "chalk";
import { refreshAntigravityToken } from "@mariozechner/pi-ai";
import {
  getAntigravityAccountManager,
  loadAccountStorage,
  resetAntigravityAccountManager,
  type ManagedAccount,
} from "../agents/antigravity-accounts.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  fetchAccountTier,
  loginAntigravityWithTier,
} from "./antigravity-oauth.js";
import { writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

export interface AntigravityAccountsListOptions {
  json?: boolean;
  plain?: boolean;
}

export async function antigravityAccountsListCommand(
  opts: AntigravityAccountsListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const storage = await loadAccountStorage();
  if (!storage || storage.accounts.length === 0) {
    if (opts.json) {
      runtime.log(JSON.stringify({ accounts: [], activeIndex: -1 }));
    } else {
      runtime.log("No Antigravity accounts configured.");
      runtime.log('Run "clawdbot antigravity accounts add" to add one.');
    }
    return;
  }

  const manager = await getAntigravityAccountManager();
  const accounts = manager.getAccounts();
  const current = manager.getCurrentAccount();

  if (opts.json) {
    runtime.log(
      JSON.stringify({
        accounts: accounts.map((a) => ({
          index: a.index,
          email: a.email,
          tier: a.tier,
          lastUsed: a.lastUsed,
          active: a.index === current?.index,
        })),
        activeIndex: current?.index ?? -1,
      }),
    );
    return;
  }

  if (opts.plain) {
    for (const account of accounts) {
      const active = account.index === current?.index ? "*" : " ";
      runtime.log(
        `${active} ${account.index}: ${account.email ?? "unknown"} (${account.tier ?? "unknown"})`,
      );
    }
    return;
  }

  runtime.log(chalk.bold.cyan("\nAntigravity Accounts"));
  runtime.log(chalk.gray("─".repeat(50)));

  for (const account of accounts) {
    const isActive = account.index === current?.index;
    const prefix = isActive ? chalk.green("→ ") : "  ";
    const tierBadge =
      account.tier === "paid" ? chalk.yellow(" [paid]") : chalk.gray(" [free]");
    const email = account.email ?? "unknown";
    const idx = chalk.dim(`#${account.index}`);

    let accessBadge = "";
    if (account.hasAccess === true) {
      accessBadge = chalk.green(" ✓");
    } else if (account.hasAccess === false) {
      accessBadge = chalk.red(" ✗");
    }

    runtime.log(`${prefix}${idx} ${email}${tierBadge}${accessBadge}`);

    if (account.lastError && account.hasAccess === false) {
      runtime.log(chalk.red(`     ⚠ ${account.lastError}`));
    }

    if (account.rateLimitResetTimes) {
      const now = Date.now();
      for (const [family, resetTime] of Object.entries(
        account.rateLimitResetTimes,
      )) {
        if (resetTime && resetTime > now) {
          const remaining = Math.ceil((resetTime - now) / 1000);
          runtime.log(
            chalk.red(`     ⚠ ${family}: rate-limited for ${remaining}s`),
          );
        }
      }
    }
  }

  runtime.log(chalk.gray("─".repeat(50)));
  const validCount = accounts.filter((a) => a.hasAccess !== false).length;
  runtime.log(
    chalk.dim(
      `Total: ${accounts.length} account(s), valid: ${validCount}, active: #${current?.index ?? 0}`,
    ),
  );
}

export async function antigravityAccountsAddCommand(
  runtime: RuntimeEnv,
): Promise<void> {
  runtime.log("Starting Antigravity OAuth flow...");
  runtime.log("A browser window will open for Google authentication.\n");

  try {
    const creds = await loginAntigravityWithTier(
      async (url: string) => {
        runtime.log(`Open this URL in your browser:\n${url}\n`);
        await openUrl(url);
      },
      (msg: string) => runtime.log(msg),
    );

    if (!creds) {
      runtime.error("OAuth failed - no credentials returned");
      return;
    }

    const manager = await getAntigravityAccountManager(
      creds.refresh,
      creds.projectId,
      creds.access,
      creds.expires,
    );

    const existingAccounts = manager.getAccounts();
    const alreadyExists = existingAccounts.some(
      (a) => a.email === creds.email && creds.email,
    );

    if (alreadyExists) {
      runtime.error(`Account ${creds.email} already exists.`);
      return;
    }

    if (existingAccounts.length > 0) {
      manager.addAccount(
        creds.refresh,
        creds.projectId,
        creds.access,
        creds.expires,
        creds.email,
        creds.tier,
      );
    } else {
      const accounts = manager.getAccounts();
      if (accounts.length > 0 && accounts[0]) {
        accounts[0].email = creds.email;
        accounts[0].tier = creds.tier;
      }
    }

    await manager.save();
    await writeOAuthCredentials("google-antigravity", creds);

    const tierLabel = creds.tier === "paid" ? "(paid)" : "(free)";
    runtime.log(
      chalk.green(`\nAdded account: ${creds.email ?? "unknown"} ${tierLabel}`),
    );
    runtime.log(chalk.dim(`Total accounts: ${manager.getAccountCount()}`));
  } catch (err) {
    runtime.error(`Failed to add account: ${String(err)}`);
  }
}

export async function antigravityAccountsRemoveCommand(
  index: number,
  runtime: RuntimeEnv,
): Promise<void> {
  const storage = await loadAccountStorage();
  if (!storage || storage.accounts.length === 0) {
    runtime.error("No Antigravity accounts configured.");
    return;
  }

  const manager = await getAntigravityAccountManager();
  const accounts = manager.getAccounts();

  if (index < 0 || index >= accounts.length) {
    runtime.error(
      `Invalid index: ${index}. Valid range: 0-${accounts.length - 1}`,
    );
    return;
  }

  const account = accounts[index];
  const removed = manager.removeAccount(index);

  if (!removed) {
    runtime.error("Failed to remove account.");
    return;
  }

  await manager.save();
  runtime.log(
    chalk.green(`Removed account #${index}: ${account?.email ?? "unknown"}`),
  );
  runtime.log(chalk.dim(`Remaining accounts: ${manager.getAccountCount()}`));
}

export async function antigravityAccountsRefreshTierCommand(
  runtime: RuntimeEnv,
): Promise<void> {
  const storage = await loadAccountStorage();
  if (!storage || storage.accounts.length === 0) {
    runtime.error("No Antigravity accounts configured.");
    return;
  }

  const manager = await getAntigravityAccountManager();
  const accounts = manager.getAccounts();

  runtime.log("Refreshing tier information for all accounts...\n");

  let updated = 0;
  for (const account of accounts) {
    if (!account.access) {
      runtime.log(chalk.yellow(`#${account.index}: Skipped (no access token)`));
      continue;
    }

    try {
      const tier = await fetchAccountTier(account.access);
      const changed = account.tier !== tier;
      account.tier = tier;

      if (changed) {
        updated++;
        runtime.log(
          chalk.green(
            `#${account.index} ${account.email ?? "unknown"}: ${tier}`,
          ),
        );
      } else {
        runtime.log(
          chalk.dim(
            `#${account.index} ${account.email ?? "unknown"}: ${tier} (unchanged)`,
          ),
        );
      }
    } catch (err) {
      runtime.log(
        chalk.red(`#${account.index}: Failed to fetch tier - ${String(err)}`),
      );
    }
  }

  await manager.save();
  runtime.log(chalk.dim(`\nUpdated ${updated} account(s).`));
}

export async function antigravityAccountsResetCommand(
  runtime: RuntimeEnv,
): Promise<void> {
  resetAntigravityAccountManager();
  runtime.log(chalk.green("Antigravity account manager cache cleared."));
  runtime.log(
    chalk.dim(
      "Note: This only clears the in-memory cache. Stored accounts remain.",
    ),
  );
}

const GEMINI_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const CLAUDE_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

async function testAccountAccess(
  accessToken: string,
  _projectId: string,
): Promise<{ success: boolean; error?: string }> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };

  for (const endpoint of GEMINI_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      });

      if (response.ok) {
        return { success: true };
      }

      const text = await response.text();
      if (text.includes("Invalid Google Cloud Code Assist credentials")) {
        return { success: false, error: "Invalid credentials" };
      }
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `Auth error: ${response.status}` };
      }
    } catch {
      continue;
    }
  }

  return { success: false, error: "All endpoints failed" };
}

async function testClaudeAccess(
  accessToken: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "antigravity/1.11.5 darwin/arm64",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };

  try {
    const response = await fetch(
      `${CLAUDE_ENDPOINT}/v1internal:generateContent`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          project: projectId,
          model: "claude-sonnet-4-5",
          userAgent: "clawdbot",
          requestId: `test-${Date.now()}`,
          request: {
            contents: [{ role: "user", parts: [{ text: "Hi" }] }],
            generationConfig: { maxOutputTokens: 10 },
          },
        }),
      },
    );

    if (response.ok) {
      return { success: true };
    }

    const text = await response.text();
    if (
      text.includes("Invalid Google Cloud Code Assist credentials") ||
      text.includes("UNAUTHENTICATED")
    ) {
      return { success: false, error: "Invalid Claude credentials" };
    }
    if (
      text.includes("quota") ||
      text.includes("rate") ||
      text.includes("RESOURCE_EXHAUSTED")
    ) {
      return { success: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: `Claude auth error: ${response.status}` };
    }

    return { success: false, error: `Claude: ${text.slice(0, 80)}` };
  } catch (err) {
    return { success: false, error: `Claude test failed: ${String(err)}` };
  }
}

export async function antigravityAccountsTestCommand(
  runtime: RuntimeEnv,
): Promise<void> {
  const storage = await loadAccountStorage();
  if (!storage || storage.accounts.length === 0) {
    runtime.error("No Antigravity accounts configured.");
    return;
  }

  const manager = await getAntigravityAccountManager();
  const accounts = manager.getAccounts();

  runtime.log("Testing Antigravity accounts...\n");

  let validCount = 0;
  let invalidCount = 0;

  for (const account of accounts) {
    const email = account.email ?? `#${account.index}`;
    runtime.log(chalk.dim(`Testing ${email}...`));

    if (!account.projectId) {
      runtime.log(chalk.red(`  ✗ No project ID`));
      manager.markInvalidCredentials(account, "No project ID");
      invalidCount++;
      continue;
    }

    let accessToken = account.access;
    const now = Date.now();
    const tokenExpired =
      !accessToken || (account.expires && now >= account.expires);

    if (tokenExpired) {
      if (!account.refreshToken) {
        runtime.log(chalk.red(`  ✗ No refresh token`));
        manager.markInvalidCredentials(account, "No refresh token");
        invalidCount++;
        continue;
      }

      try {
        const result = await refreshAntigravityToken(
          account.refreshToken,
          account.projectId,
        );
        if (result?.access) {
          accessToken = result.access;
          account.access = result.access;
          account.expires = result.expires;
        } else {
          runtime.log(chalk.red(`  ✗ Token refresh failed`));
          manager.markInvalidCredentials(account, "Token refresh failed");
          invalidCount++;
          continue;
        }
      } catch (err) {
        runtime.log(chalk.red(`  ✗ Token refresh error: ${String(err)}`));
        manager.markInvalidCredentials(
          account,
          `Refresh error: ${String(err)}`,
        );
        invalidCount++;
        continue;
      }
    }

    const result = await testAccountAccess(accessToken!, account.projectId);
    const claudeResult = await testClaudeAccess(
      accessToken!,
      account.projectId,
    );

    if (result.success && claudeResult.success) {
      runtime.log(chalk.green(`  ✓ Valid (Gemini + Claude)`));
      manager.markValidCredentials(account);
      validCount++;
    } else if (result.success) {
      runtime.log(
        chalk.yellow(`  ⚠ Gemini only (Claude: ${claudeResult.error})`),
      );
      manager.markValidCredentials(account);
      validCount++;
    } else {
      runtime.log(chalk.red(`  ✗ ${result.error}`));
      manager.markInvalidCredentials(account, result.error ?? "Unknown error");
      invalidCount++;
    }
  }

  await manager.save();

  runtime.log(chalk.gray("\n" + "─".repeat(50)));
  runtime.log(
    `Results: ${chalk.green(`${validCount} valid`)}, ${chalk.red(`${invalidCount} invalid`)}`,
  );

  if (invalidCount > 0 && validCount === 0) {
    runtime.log(
      chalk.yellow(
        "\nAll accounts have invalid credentials. Run 'clawdbot antigravity accounts add' to add a working account.",
      ),
    );
  }
}
