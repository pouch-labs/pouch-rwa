import { account, wallet } from "./chain.js";
import { config } from "./config.js";
import { profileToken, searchTokens, type TokenProfile, type TokenSearchResult } from "./discovery.js";
import { spentUsdLast24h, tradeHistory, transferHistory, type TradeRecord, type TransferRecord } from "./guardrails.js";
import { usMarketStatus, type MarketStatus } from "./markets.js";
import {
  executeSend,
  executeSwap,
  getPortfolio,
  getQuote,
  type Portfolio,
  type QuoteResult,
  type SendParams,
  type SendResult,
  type SwapParams,
  type SwapResult,
} from "./trading.js";

export interface Limits {
  dailyBudgetUsd: number;
  spentUsdLast24h: number;
  remainingUsd: number;
  tiers: typeof config.policy.tiers;
  market: MarketStatus;
}

/**
 * The pouch SDK: a guardrailed RWA trading wallet for autonomous agents on
 * Robinhood Chain. Every trade is valued in USD and checked against the
 * owner's policy (trust tiers, per-trade limits, rolling 24h budget) before
 * anything is signed.
 *
 * The wallet key resolves from POUCH_PRIVATE_KEY, then ~/.pouch/wallet.json,
 * and is generated on first use otherwise. Policy loads from POUCH_CONFIG,
 * ./pouch.config.json, or ~/.pouch/config.json.
 *
 * ```ts
 * import { Pouch } from "pouch-rwa";
 *
 * const pouch = new Pouch();
 * const [tsla] = await pouch.search("TSLA");
 * const profile = await pouch.profile(tsla.address);
 * if (profile.tier === "official") {
 *   await pouch.buyUsd(profile.address, 50); // $50 of tokenized TSLA, guardrails enforced
 * }
 * ```
 */
export class Pouch {
  /** The wallet address trades execute from. */
  get address(): string {
    return account.address;
  }

  /** Where the key came from: env, keystore file, or freshly generated. */
  get keySource(): string {
    return wallet.source;
  }

  /** Search tokens on Robinhood Chain by name or symbol. Names are fakeable: always profile() before trading. */
  search(query: string): Promise<TokenSearchResult[]> {
    return searchTokens(query);
  }

  /** Classify a token into a trust tier using on-chain signals that cost money to fake. */
  profile(address: string): Promise<TokenProfile> {
    return profileToken(address);
  }

  /** Executable price for an exact-input swap, without signing anything. */
  quote(tokenIn: string, tokenOut: string, amountIn: string): Promise<QuoteResult> {
    return getQuote(tokenIn, tokenOut, amountIn);
  }

  /** Guardrailed swap. One side must be USDG or ETH. Throws (without signing) when policy blocks it. */
  swap(params: SwapParams): Promise<SwapResult> {
    return executeSwap(params);
  }

  /** Buy a token with USDG, sized in dollars (USDG is 1:1 USD). */
  buyUsd(token: string, usd: number, slippageBps?: number): Promise<SwapResult> {
    return executeSwap({ tokenIn: "USDG", tokenOut: token, amountIn: usd.toFixed(2), slippageBps });
  }

  /** Sell an exact token amount back into USDG. */
  sell(token: string, amount: string, slippageBps?: number): Promise<SwapResult> {
    return executeSwap({ tokenIn: token, tokenOut: "USDG", amountIn: amount, slippageBps });
  }

  /** Guardrailed outbound transfer. Disabled by default policy. */
  send(params: SendParams): Promise<SendResult> {
    return executeSend(params);
  }

  /** Current holdings: ETH, USDG, and live balances of previously traded tokens. */
  portfolio(): Promise<Portfolio> {
    return getPortfolio();
  }

  /** The active policy and how much of the rolling 24h budget is used. */
  limits(): Limits {
    const spent = spentUsdLast24h();
    return {
      dailyBudgetUsd: config.policy.dailyBudgetUsd,
      spentUsdLast24h: spent,
      remainingUsd: Math.max(0, config.policy.dailyBudgetUsd - spent),
      tiers: config.policy.tiers,
      market: usMarketStatus(),
    };
  }

  /** Recent trades, newest first. */
  trades(limit = 20): TradeRecord[] {
    return tradeHistory(limit);
  }

  /** Recent outbound transfers, newest first. */
  transfers(limit = 20): TransferRecord[] {
    return transferHistory(limit);
  }
}
