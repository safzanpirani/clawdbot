import { promises as fs } from "node:fs";
import path from "node:path";
import { STATE_DIR_CLAWDBOT } from "../config/paths.js";

export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";
export type AccountTier = "free" | "paid";

export interface RateLimitState {
  claude?: number;
  "gemini-flash"?: number;
  "gemini-pro"?: number;
}

export interface AccountMetadata {
  email?: string;
  tier?: AccountTier;
  refreshToken: string;
  projectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation" | "invalid-creds";
  rateLimitResetTimes?: RateLimitState;
  access?: string;
  expires?: number;
  hasAccess?: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

export type AntigravityAccountSeed = {
  refresh: string;
  projectId?: string;
  access?: string;
  expires?: number;
  email?: string;
  tier?: AccountTier;
};

export interface ManagedAccount {
  index: number;
  refreshToken: string;
  projectId?: string;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitState;
  lastUsed: number;
  email?: string;
  tier?: AccountTier;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation" | "invalid-creds";
  hasAccess?: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

const ACCOUNTS_FILENAME = "antigravity-accounts.json";
export const MAX_ACCOUNTS = 10;

function getAccountsPath(): string {
  return path.join(STATE_DIR_CLAWDBOT, ACCOUNTS_FILENAME);
}

export async function loadAccountStorage(): Promise<AccountStorage | null> {
  try {
    const filepath = getAccountsPath();
    const content = await fs.readFile(filepath, "utf-8");
    const data = JSON.parse(content) as AccountStorage;

    if (!Array.isArray(data.accounts)) {
      return null;
    }

    if (data.version !== 2) {
      return null;
    }

    if (
      typeof data.activeIndex !== "number" ||
      data.activeIndex < 0 ||
      data.activeIndex >= data.accounts.length
    ) {
      data.activeIndex = 0;
    }

    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function saveAccountStorage(
  storage: AccountStorage,
): Promise<void> {
  const filepath = getAccountsPath();
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(filepath, JSON.stringify(storage, null, 2), "utf-8");
  await fs.chmod(filepath, 0o600);
}

function isRateLimitedForFamily(
  account: ManagedAccount,
  family: ModelFamily,
): boolean {
  const resetTime = account.rateLimitResetTimes[family];
  return resetTime !== undefined && Date.now() < resetTime;
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = Date.now();
  for (const key of Object.keys(account.rateLimitResetTimes) as ModelFamily[]) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

export function getModelFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

export function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("claude");
}

export class AntigravityAccountManager {
  private accounts: ManagedAccount[] = [];
  private currentAccountIndex = 0;
  private rotationIndex = 0;

  constructor(
    initialRefreshToken?: string,
    initialProjectId?: string,
    initialAccess?: string,
    initialExpires?: number,
    storedAccounts?: AccountStorage | null,
  ) {
    if (storedAccounts && storedAccounts.accounts.length > 0) {
      this.currentAccountIndex = Math.max(
        0,
        Math.min(
          storedAccounts.activeIndex,
          storedAccounts.accounts.length - 1,
        ),
      );
      this.rotationIndex = this.currentAccountIndex;

      this.accounts = storedAccounts.accounts.map((acc, index) => ({
        index,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        access:
          acc.access ??
          (index === this.currentAccountIndex ? initialAccess : undefined),
        expires:
          acc.expires ??
          (index === this.currentAccountIndex ? initialExpires : undefined),
        rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
        lastUsed: acc.lastUsed,
        email: acc.email,
        tier: acc.tier,
        lastSwitchReason: acc.lastSwitchReason,
        hasAccess: acc.hasAccess,
        lastError: acc.lastError,
        lastErrorAt: acc.lastErrorAt,
      }));
    } else if (initialRefreshToken) {
      this.accounts = [
        {
          index: 0,
          refreshToken: initialRefreshToken,
          projectId: initialProjectId,
          access: initialAccess,
          expires: initialExpires,
          rateLimitResetTimes: {},
          lastUsed: Date.now(),
        },
      ];
      this.currentAccountIndex = 0;
    }
  }

  async save(): Promise<void> {
    const storage: AccountStorage = {
      version: 2,
      accounts: this.accounts.map((acc) => ({
        email: acc.email,
        tier: acc.tier,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        addedAt: acc.lastUsed || Date.now(),
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        access: acc.access,
        expires: acc.expires,
        hasAccess: acc.hasAccess,
        lastError: acc.lastError,
        lastErrorAt: acc.lastErrorAt,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };
    await saveAccountStorage(storage);
  }

  getCurrentAccount(): ManagedAccount | null {
    if (
      this.currentAccountIndex >= 0 &&
      this.currentAccountIndex < this.accounts.length
    ) {
      return this.accounts[this.currentAccountIndex] ?? null;
    }
    return null;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  findAccountByRefreshToken(refreshToken: string): ManagedAccount | null {
    return (
      this.accounts.find((account) => account.refreshToken === refreshToken) ??
      null
    );
  }

  selectAccountForFamily(
    family: ModelFamily,
    mode: "sticky" | "round-robin" = "sticky",
  ): ManagedAccount | null {
    if (mode === "round-robin" && this.accounts.length > 1) {
      const next = this.getNextForFamily(family);
      if (next) {
        this.markSwitched(next, "rotation");
      }
      return next;
    }
    return this.getCurrentOrNextForFamily(family);
  }

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const current = this.getCurrentAccount();
    if (current && !isRateLimitedForFamily(current, family)) {
      const betterTierAvailable =
        current.tier !== "paid" &&
        this.accounts.some(
          (a) => a.tier === "paid" && !isRateLimitedForFamily(a, family),
        );

      if (!betterTierAvailable) {
        current.lastUsed = Date.now();
        return current;
      }
    }

    const next = this.getNextForFamily(family);
    if (next) {
      this.currentAccountIndex = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter(
      (a) => !isRateLimitedForFamily(a, family) && a.hasAccess !== false,
    );

    if (available.length === 0) {
      return null;
    }

    const paidAvailable = available.filter((a) => a.tier === "paid");
    const confirmedAccess = available.filter((a) => a.hasAccess === true);

    let pool: ManagedAccount[];
    if (confirmedAccess.length > 0) {
      const paidConfirmed = confirmedAccess.filter((a) => a.tier === "paid");
      pool = paidConfirmed.length > 0 ? paidConfirmed : confirmedAccess;
    } else {
      pool = paidAvailable.length > 0 ? paidAvailable : available;
    }

    const account = pool[this.rotationIndex % pool.length];
    if (!account) {
      return null;
    }

    this.rotationIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
  ): void {
    account.rateLimitResetTimes[family] = Date.now() + retryAfterMs;
    account.lastSwitchReason = "rate-limit";
  }

  markSwitched(
    account: ManagedAccount,
    reason: "rate-limit" | "initial" | "rotation" | "invalid-creds",
  ): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndex = account.index;
  }

  markInvalidCredentials(account: ManagedAccount, error: string): void {
    account.hasAccess = false;
    account.lastError = error;
    account.lastErrorAt = Date.now();
    account.lastSwitchReason = "invalid-creds";
  }

  markValidCredentials(account: ManagedAccount): void {
    account.hasAccess = true;
    account.lastError = undefined;
    account.lastErrorAt = undefined;
  }

  getAccountsWithAccess(): ManagedAccount[] {
    return this.accounts.filter((a) => a.hasAccess !== false);
  }

  getAccountsWithoutAccess(): ManagedAccount[] {
    return this.accounts.filter((a) => a.hasAccess === false);
  }

  updateAccount(
    account: ManagedAccount,
    access?: string,
    expires?: number,
    refreshToken?: string,
    projectId?: string,
    email?: string,
    tier?: AccountTier,
  ): void {
    if (access !== undefined) {
      account.access = access;
    }
    if (expires !== undefined) {
      account.expires = expires;
    }
    if (refreshToken) {
      account.refreshToken = refreshToken;
    }
    if (projectId) {
      account.projectId = projectId;
    }
    if (email !== undefined) {
      account.email = email;
    }
    if (tier !== undefined) {
      account.tier = tier;
    }
  }

  addAccount(
    refreshToken: string,
    projectId?: string,
    access?: string,
    expires?: number,
    email?: string,
    tier?: AccountTier,
  ): boolean {
    if (this.accounts.length >= MAX_ACCOUNTS) {
      return false;
    }

    this.accounts.push({
      index: this.accounts.length,
      refreshToken,
      projectId,
      access,
      expires,
      rateLimitResetTimes: {},
      lastUsed: 0,
      email,
      tier,
    });

    this.accounts.forEach((acc, idx) => {
      acc.index = idx;
    });

    return true;
  }

  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }

    this.accounts.splice(index, 1);

    this.accounts.forEach((acc, idx) => {
      acc.index = idx;
    });

    if (this.currentAccountIndex >= this.accounts.length) {
      this.currentAccountIndex = Math.max(0, this.accounts.length - 1);
    }

    return true;
  }

  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });

    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .map((a) => a.rateLimitResetTimes[family])
      .filter((t): t is number => t !== undefined)
      .map((t) => Math.max(0, t - Date.now()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
}

export async function persistAntigravityAccounts(
  seeds: AntigravityAccountSeed[],
): Promise<ManagedAccount | null> {
  if (seeds.length === 0) return null;
  const [first] = seeds;
  if (!first) return null;
  const accountManager = await getAntigravityAccountManager(
    first.refresh,
    first.projectId,
    first.access,
    first.expires,
  );
  for (const seed of seeds) {
    const existing = accountManager.findAccountByRefreshToken(seed.refresh);
    if (existing) {
      accountManager.updateAccount(
        existing,
        seed.access,
        seed.expires,
        seed.refresh,
        seed.projectId,
        seed.email,
        seed.tier,
      );
      continue;
    }
    accountManager.addAccount(
      seed.refresh,
      seed.projectId,
      seed.access,
      seed.expires,
      seed.email,
      seed.tier,
    );
  }
  const preferred = accountManager.findAccountByRefreshToken(first.refresh);
  if (preferred) {
    accountManager.markSwitched(preferred, "initial");
  } else if (!accountManager.getCurrentAccount()) {
    const fallback = accountManager.getAccounts()[0] ?? null;
    if (fallback) {
      accountManager.markSwitched(fallback, "initial");
    }
  }
  await accountManager.save();
  return accountManager.getCurrentAccount();
}

let accountManagerInstance: AntigravityAccountManager | null = null;

export async function getAntigravityAccountManager(
  initialRefreshToken?: string,
  initialProjectId?: string,
  initialAccess?: string,
  initialExpires?: number,
): Promise<AntigravityAccountManager> {
  if (!accountManagerInstance) {
    const stored = await loadAccountStorage();
    accountManagerInstance = new AntigravityAccountManager(
      initialRefreshToken,
      initialProjectId,
      initialAccess,
      initialExpires,
      stored,
    );
  }
  return accountManagerInstance;
}

export function resetAntigravityAccountManager(): void {
  accountManagerInstance = null;
}
