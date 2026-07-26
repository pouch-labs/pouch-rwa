import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.js";
import { POUCH_HOME } from "./keystore.js";
import type { Tier } from "./discovery.js";

export interface TradeRecord {
  timestamp: number;
  tokenIn: string;
  tokenOut: string;
  /** Contract address of the non-quote side, when the trade involved one. */
  tokenInAddress?: string;
  tokenOutAddress?: string;
  amountIn: string;
  amountOut: string;
  usdValue: number;
  tier: Tier;
  txHash: string;
}

export interface TransferRecord {
  timestamp: number;
  token: string;
  amount: string;
  to: string;
  usdValue: number;
  txHash: string;
}

interface State {
  trades: TradeRecord[];
  transfers?: TransferRecord[];
}

const statePath = config.stateFile
  ? resolve(config.stateFile)
  : join(POUCH_HOME, "state.json");

function loadState(): State {
  if (!existsSync(statePath)) return { trades: [] };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function recordTrade(trade: TradeRecord): void {
  const state = loadState();
  state.trades.push(trade);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function tradeHistory(limit = 20): TradeRecord[] {
  return loadState().trades.slice(-limit).reverse();
}

/** USD turnover in the rolling 24h window. */
export function spentUsdLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return loadState()
    .trades.filter((t) => t.timestamp >= cutoff)
    .reduce((sum, t) => sum + t.usdValue, 0);
}

export function recordTransfer(transfer: TransferRecord): void {
  const state = loadState();
  (state.transfers ??= []).push(transfer);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function transferHistory(limit = 20): TransferRecord[] {
  return (loadState().transfers ?? []).slice(-limit).reverse();
}

/** Outbound-transfer spend in the rolling 24h window. Tracked separately from trading turnover. */
export function transfersSpentUsdLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (loadState().transfers ?? [])
    .filter((t) => t.timestamp >= cutoff)
    .reduce((sum, t) => sum + t.usdValue, 0);
}

/**
 * The transfer guardrail check, run before an outbound transfer is signed.
 * Throws a descriptive error the agent can read and adapt to.
 */
export function checkTransferAllowed(to: string, transferUsd: number): void {
  const { transfers } = config.policy;
  if (!transfers.enabled) {
    throw new Error(
      "Transfer blocked: outbound transfers are disabled by policy. " +
        "The owner can enable policy.transfers.enabled in the config."
    );
  }
  if (transfers.allowlist.length > 0 && !transfers.allowlist.includes(to.toLowerCase())) {
    throw new Error(
      `Transfer blocked: ${to} is not in the transfer allowlist. ` +
        `The owner can extend policy.transfers.allowlist in the config.`
    );
  }
  if (transferUsd > transfers.maxPerTransferUsd) {
    throw new Error(
      `Transfer blocked: ~$${transferUsd.toFixed(2)} exceeds the $${transfers.maxPerTransferUsd} per-transfer limit.`
    );
  }
  const spent = transfersSpentUsdLast24h();
  const remaining = transfers.dailyBudgetUsd - spent;
  if (transferUsd > remaining) {
    throw new Error(
      `Transfer blocked: transfer budget is $${transfers.dailyBudgetUsd}/24h, ~$${spent.toFixed(2)} already sent, only ~$${Math.max(0, remaining).toFixed(2)} remaining.`
    );
  }
}

/**
 * The trade guardrail check, run before anything is signed.
 * Throws a descriptive error the agent can read and adapt to.
 */
export function checkTradeAllowed(tier: Tier, tradeUsd: number, tierReasons: string[]): void {
  const tierPolicy = config.policy.tiers[tier];

  if (!tierPolicy.enabled) {
    throw new Error(
      `Trade blocked: "${tier}"-tier tokens are disabled by policy. Classification: ${tierReasons.join("; ")}`
    );
  }
  if (tradeUsd > tierPolicy.maxPerTradeUsd) {
    throw new Error(
      `Trade blocked: ~$${tradeUsd.toFixed(2)} exceeds the $${tierPolicy.maxPerTradeUsd} per-trade limit for ${tier}-tier tokens.`
    );
  }
  const spent = spentUsdLast24h();
  const remaining = config.policy.dailyBudgetUsd - spent;
  if (tradeUsd > remaining) {
    throw new Error(
      `Trade blocked: daily budget is $${config.policy.dailyBudgetUsd}, ~$${spent.toFixed(2)} already used in the last 24h, only ~$${Math.max(0, remaining).toFixed(2)} remaining.`
    );
  }
}
