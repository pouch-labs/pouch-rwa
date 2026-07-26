/**
 * pouch-rwa: an RWA trading wallet SDK for AI agents on Robinhood Chain.
 *
 * High-level entry point: the Pouch class. The lower-level building blocks
 * (discovery, quoting, guardrails, execution) are exported too for agents
 * that need finer control. Run the bundled MCP server with: npx pouch-rwa
 */
export { Pouch, type Limits } from "./pouch.js";

// Trading core
export {
  balanceOf,
  executeSend,
  executeSwap,
  getPortfolio,
  getQuote,
  isQuoteCurrency,
  resolveCurrency,
  resolvePair,
  type Portfolio,
  type Position,
  type QuoteResult,
  type ResolvedPair,
  type SendParams,
  type SendResult,
  type SwapParams,
  type SwapResult,
} from "./trading.js";

// Discovery & classification
export {
  findPairPools,
  findQuotePools,
  profileToken,
  searchTokens,
  type PoolInfo,
  type Tier,
  type TokenProfile,
  type TokenSearchResult,
} from "./discovery.js";

// Guardrails & history
export {
  checkTradeAllowed,
  checkTransferAllowed,
  spentUsdLast24h,
  tradeHistory,
  transferHistory,
  transfersSpentUsdLast24h,
  type TradeRecord,
  type TransferRecord,
} from "./guardrails.js";

// Quoting & execution primitives
export { bestQuote, ethUsdPrice, isNative, quotePool, swapV4, usdValue } from "./v4.js";

// Market hours
export { OFF_HOURS_WARNING, usMarketStatus, type MarketStatus } from "./markets.js";

// Chain constants & config
export {
  BLOCKSCOUT,
  CHAIN_ID,
  DEFAULT_RPC,
  NATIVE,
  OFFICIAL_ISSUER,
  OFFICIAL_STOCK_CODEHASH,
  USDG,
  USDG_DECIMALS,
  account,
  chain,
  publicClient,
  wallet,
  walletClient,
} from "./chain.js";
export { config, type Policy, type PouchConfig, type StocksPolicy, type TierPolicy, type TransfersPolicy, type TrustedIssuer } from "./config.js";
export { POUCH_HOME } from "./keystore.js";
