import type { Command } from "commander";
import {
  antigravityAccountsAddCommand,
  antigravityAccountsListCommand,
  antigravityAccountsRefreshTierCommand,
  antigravityAccountsRemoveCommand,
  antigravityAccountsResetCommand,
  antigravityAccountsTestCommand,
} from "../commands/antigravity.js";
import { defaultRuntime } from "../runtime.js";

export function registerAntigravityCli(program: Command) {
  const antigravity = program
    .command("antigravity")
    .description("Manage Antigravity OAuth accounts for load balancing");

  const accounts = antigravity
    .command("accounts")
    .description("Manage multiple Antigravity accounts");

  accounts
    .command("list")
    .description("List configured Antigravity accounts")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain line output", false)
    .action(async (opts) => {
      try {
        await antigravityAccountsListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts
    .command("add")
    .description("Add a new Antigravity account")
    .action(async () => {
      try {
        await antigravityAccountsAddCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts
    .command("remove")
    .description("Remove an Antigravity account by index")
    .argument("<index>", "Account index to remove")
    .action(async (indexStr: string) => {
      try {
        const index = Number.parseInt(indexStr, 10);
        if (Number.isNaN(index)) {
          defaultRuntime.error("Invalid index: must be a number");
          defaultRuntime.exit(1);
          return;
        }
        await antigravityAccountsRemoveCommand(index, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts
    .command("refresh-tier")
    .description("Refresh tier information for all accounts")
    .action(async () => {
      try {
        await antigravityAccountsRefreshTierCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts
    .command("reset")
    .description("Clear the in-memory account manager cache")
    .action(async () => {
      try {
        await antigravityAccountsResetCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts
    .command("test")
    .description("Test all accounts for valid API access")
    .action(async () => {
      try {
        await antigravityAccountsTestCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  accounts.action(async () => {
    try {
      await antigravityAccountsListCommand({}, defaultRuntime);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  antigravity.action(async () => {
    try {
      await antigravityAccountsListCommand({}, defaultRuntime);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
}
