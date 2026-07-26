import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POUCH_HOME } from "./keystore.js";

export interface TierPolicy {
  enabled: boolean;
  /** Max USD value of a single trade in this tier. */
  maxPerTradeUsd: number;
}

export interface TransfersPolicy {
  /**
   * Off by default: outbound transfers are the riskiest tool (a prompt-
   * injected agent could drain the wallet), so withdrawals are opt-in.
   */
  enabled: boolean;
  /** Max USD value of a single outbound transfer. */
  maxPerTransferUsd: number;
  /** Total USD the agent may send externally across any rolling 24h. */
  dailyBudgetUsd: number;
  /**
   * Recipient addresses the agent may send to. Empty means any address;
   * populate it to restrict withdrawals to known-good destinations.
   */
  allowlist: string[];
}

export interface TrustedIssuer {
  /** Display name, e.g. "Backed Finance". Shown in tier reasons. */
  name: string;
  /** Deployer address of the issuer's token contracts (cross-checked via the explorer). */
  deployer?: string;
  /** keccak256 of the runtime bytecode shared by the issuer's tokens. */
  codehash?: string;
}

export interface StocksPolicy {
  /**
   * Stock tokens trade 24/7 but the underlying market does not; off-hours pool
   * prices can drift from the last NYSE close. Set true to block official
   * stock-token trades while the US market is closed (default: warn only).
   */
  blockOffHoursTrades: boolean;
}

export interface Policy {
  /** Total USD turnover the agent may generate across any rolling 24h. */
  dailyBudgetUsd: number;
  tiers: {
    /** Official Robinhood stock tokens (verified by on-chain codehash). */
    official: TierPolicy;
    /** RWA tokens matching an entry in trustedIssuers (empty by default). */
    issuer: TierPolicy;
    /** Tokens with real liquidity, 1000+ holders, and an indexed price feed. */
    established: TierPolicy;
    /** Everything else. Off by default; this is where the scams live. */
    unknown: TierPolicy;
  };
  /** Established-tier threshold: minimum holder count. */
  minHolders: number;
  /** Token addresses the agent may never trade, regardless of tier. */
  denylist: string[];
  /**
   * Non-Robinhood RWA issuers the owner trusts. Tokens matching an entry's
   * codehash and/or deployer (all provided criteria must pass, plus a live
   * quote pool) classify into the "issuer" tier instead of falling to
   * "established"/"unknown".
   */
  trustedIssuers: TrustedIssuer[];
  /** Off-hours behavior for official stock tokens. */
  stocks: StocksPolicy;
  /** Outbound transfer (withdrawal) limits. */
  transfers: TransfersPolicy;
}

export interface PouchConfig {
  rpcUrl?: string;
  policy: Policy;
  /** Where trade history / spend tracking is stored. Default: ~/.pouch/state.json */
  stateFile?: string;
}

const DEFAULT_POLICY: Policy = {
  dailyBudgetUsd: 1000,
  tiers: {
    official: { enabled: true, maxPerTradeUsd: 500 },
    issuer: { enabled: true, maxPerTradeUsd: 250 },
    established: { enabled: true, maxPerTradeUsd: 100 },
    unknown: { enabled: false, maxPerTradeUsd: 0 },
  },
  minHolders: 1000,
  denylist: [],
  trustedIssuers: [],
  stocks: { blockOffHoursTrades: false },
  transfers: {
    enabled: false,
    maxPerTransferUsd: 100,
    dailyBudgetUsd: 250,
    allowlist: [],
  },
};

/** Config search order: explicit env path, then cwd, then ~/.pouch/config.json. */
function findConfigPath(): string | null {
  if (process.env.POUCH_CONFIG) return resolve(process.env.POUCH_CONFIG);
  const cwdPath = resolve("pouch.config.json");
  if (existsSync(cwdPath)) return cwdPath;
  const homePath = join(POUCH_HOME, "config.json");
  if (existsSync(homePath)) return homePath;
  return null;
}

function loadConfig(): PouchConfig {
  const path = findConfigPath();
  if (!path) return { policy: DEFAULT_POLICY };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PouchConfig>;
  return {
    ...raw,
    policy: {
      ...DEFAULT_POLICY,
      ...raw.policy,
      tiers: { ...DEFAULT_POLICY.tiers, ...raw.policy?.tiers },
      denylist: (raw.policy?.denylist ?? []).map((a) => a.toLowerCase()),
      trustedIssuers: (raw.policy?.trustedIssuers ?? []).map((i) => ({
        name: i.name,
        deployer: i.deployer?.toLowerCase(),
        codehash: i.codehash?.toLowerCase(),
      })),
      stocks: { ...DEFAULT_POLICY.stocks, ...raw.policy?.stocks },
      transfers: {
        ...DEFAULT_POLICY.transfers,
        ...raw.policy?.transfers,
        allowlist: (raw.policy?.transfers?.allowlist ?? []).map((a) => a.toLowerCase()),
      },
    },
  };
}

export const config = loadConfig();
