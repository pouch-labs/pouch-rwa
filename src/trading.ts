import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import {
  BLOCKSCOUT,
  NATIVE,
  USDG,
  USDG_DECIMALS,
  account,
  erc20Abi,
  publicClient,
  walletClient,
} from "./chain.js";
import { config } from "./config.js";
import { findPairPools, profileToken, type PoolInfo, type Tier } from "./discovery.js";
import {
  checkTradeAllowed,
  checkTransferAllowed,
  recordTrade,
  recordTransfer,
  tradeHistory,
} from "./guardrails.js";
import { OFF_HOURS_WARNING, usMarketStatus, type MarketStatus } from "./markets.js";
import { bestQuote, ethUsdPrice, isNative, swapV4, usdValue } from "./v4.js";

export function resolveCurrency(input: string): Address {
  const upper = input.trim().toUpperCase();
  if (upper === "ETH") return NATIVE;
  if (upper === "USDG") return USDG;
  return getAddress(input.trim());
}

export function isQuoteCurrency(address: Address): boolean {
  return isNative(address) || address.toLowerCase() === USDG.toLowerCase();
}

export async function balanceOf(currency: Address): Promise<bigint> {
  if (isNative(currency)) return publicClient.getBalance({ address: account.address });
  return publicClient.readContract({
    address: currency,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
}

export interface ResolvedPair {
  tokenIn: Address;
  tokenOut: Address;
  pools: PoolInfo[];
  tier: Tier;
  tierReasons: string[];
  isStock: boolean;
  inDecimals: number;
  outDecimals: number;
  inSymbol: string;
  outSymbol: string;
  profilePools: PoolInfo[];
}

/**
 * Resolve a trading pair. Exactly one side must be a quote currency (USDG or
 * ETH), except the ETH/USDG pair itself which is always allowed.
 */
export async function resolvePair(tokenInRaw: string, tokenOutRaw: string): Promise<ResolvedPair> {
  const tokenIn = resolveCurrency(tokenInRaw);
  const tokenOut = resolveCurrency(tokenOutRaw);
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error("token_in and token_out are the same currency.");
  }

  // ETH <-> USDG: both sides are quotes, no token to profile.
  if (isQuoteCurrency(tokenIn) && isQuoteCurrency(tokenOut)) {
    const pools = await findPairPools(NATIVE, USDG);
    return {
      tokenIn,
      tokenOut,
      pools,
      tier: "official" as Tier,
      tierReasons: ["native ETH / USDG quote pair"],
      isStock: false,
      inDecimals: isNative(tokenIn) ? 18 : USDG_DECIMALS,
      outDecimals: isNative(tokenOut) ? 18 : USDG_DECIMALS,
      inSymbol: isNative(tokenIn) ? "ETH" : "USDG",
      outSymbol: isNative(tokenOut) ? "ETH" : "USDG",
      profilePools: pools,
    };
  }

  if (isQuoteCurrency(tokenIn) === isQuoteCurrency(tokenOut)) {
    throw new Error(
      "One side of the pair must be USDG or ETH (token-to-token routing is not supported yet)."
    );
  }

  const quote = isQuoteCurrency(tokenIn) ? tokenIn : tokenOut;
  const other = isQuoteCurrency(tokenIn) ? tokenOut : tokenIn;
  const p = await profileToken(other);
  const pairPools = p.pools.filter((pool) => pool.quote.toLowerCase() === quote.toLowerCase());
  if (!pairPools.some((pool) => pool.liquidity > 0n)) {
    const otherQuote = isNative(quote) ? "USDG" : "ETH";
    const alt = p.pools.filter((pool) => pool.liquidity > 0n).length;
    throw new Error(
      `${p.symbol} has no live pool against ${isNative(quote) ? "ETH" : "USDG"}.` +
        (alt > 0 ? ` Try quoting against ${otherQuote} instead.` : "")
    );
  }

  const quoteDecimals = isNative(quote) ? 18 : USDG_DECIMALS;
  const quoteSymbol = isNative(quote) ? "ETH" : "USDG";
  return {
    tokenIn,
    tokenOut,
    pools: pairPools,
    tier: p.tier,
    tierReasons: p.tierReasons,
    isStock: p.isStock,
    inDecimals: isQuoteCurrency(tokenIn) ? quoteDecimals : p.decimals,
    outDecimals: isQuoteCurrency(tokenOut) ? quoteDecimals : p.decimals,
    inSymbol: isQuoteCurrency(tokenIn) ? quoteSymbol : p.symbol,
    outSymbol: isQuoteCurrency(tokenOut) ? quoteSymbol : p.symbol,
    profilePools: p.pools,
  };
}

export interface QuoteResult {
  amountIn: string;
  amountOut: string;
  inSymbol: string;
  outSymbol: string;
  usdValue: number;
  tier: Tier;
  pool: { quoteSymbol: string; fee: number; liquidity: bigint };
  /** Present for official stock tokens: whether NYSE is currently open. */
  market: MarketStatus | null;
}

/** Executable price for an exact-input swap, without signing anything. */
export async function getQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<QuoteResult> {
  const pair = await resolvePair(tokenIn, tokenOut);
  const amountInRaw = parseUnits(amountIn, pair.inDecimals);
  const { pool, amountOut } = await bestQuote(pair.pools, pair.tokenIn, amountInRaw);
  const tradeUsd = await usdValue(pair.tokenIn, amountInRaw, pair.inDecimals, pair.profilePools);
  return {
    amountIn,
    amountOut: formatUnits(amountOut, pair.outDecimals),
    inSymbol: pair.inSymbol,
    outSymbol: pair.outSymbol,
    usdValue: tradeUsd,
    tier: pair.tier,
    pool: { quoteSymbol: pool.quoteSymbol, fee: pool.fee, liquidity: pool.liquidity },
    market: pair.isStock ? usMarketStatus() : null,
  };
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** Max slippage vs the quoted price, in basis points (default 100 = 1%). */
  slippageBps?: number;
}

export interface SwapResult {
  txHash: string;
  explorerUrl: string;
  sold: string;
  received: string;
  inSymbol: string;
  outSymbol: string;
  usdValue: number;
  tier: Tier;
  /** Present when an official stock token traded while NYSE was closed. */
  offHoursNote: string | null;
}

/**
 * Guardrailed swap: values the trade in USD, runs the policy checks, and only
 * then signs. A blocked trade throws before anything touches the chain.
 */
export async function executeSwap(params: SwapParams): Promise<SwapResult> {
  const pair = await resolvePair(params.tokenIn, params.tokenOut);
  const amountIn = parseUnits(params.amountIn, pair.inDecimals);

  // Balance check, with a gas cushion when spending native ETH.
  const inBalance = await balanceOf(pair.tokenIn);
  const gasCushion = isNative(pair.tokenIn) ? parseUnits("0.0005", 18) : 0n;
  if (inBalance < amountIn + gasCushion) {
    throw new Error(
      `Insufficient ${pair.inSymbol}: have ${formatUnits(inBalance, pair.inDecimals)}, ` +
        `need ${params.amountIn}${gasCushion > 0n ? " plus a small gas reserve" : ""}.`
    );
  }

  // Value the trade in USD, then run the guardrails, before any signing.
  const tradeUsd = await usdValue(pair.tokenIn, amountIn, pair.inDecimals, pair.profilePools);
  checkTradeAllowed(pair.tier, tradeUsd, pair.tierReasons);

  // Market-hours guardrail for official stock tokens.
  const market = pair.isStock ? usMarketStatus() : null;
  if (market && !market.open && config.policy.stocks.blockOffHoursTrades) {
    throw new Error(
      `Trade blocked: ${market.detail}. ${OFF_HOURS_WARNING} ` +
        `The owner can allow off-hours stock trades by setting policy.stocks.blockOffHoursTrades to false.`
    );
  }

  const { pool, amountOut: quoted } = await bestQuote(pair.pools, pair.tokenIn, amountIn);
  const minOut = (quoted * BigInt(10_000 - (params.slippageBps ?? 100))) / 10_000n;

  const outBefore = await balanceOf(pair.tokenOut);
  const { txHash, gasCostWei } = await swapV4(pool, pair.tokenIn, pair.tokenOut, amountIn, minOut);
  const outAfter = await balanceOf(pair.tokenOut);
  // Native-ETH output is measured net of the gas this tx burned.
  const rawDelta = outAfter - outBefore;
  const received = formatUnits(
    isNative(pair.tokenOut) ? rawDelta + gasCostWei : rawDelta,
    pair.outDecimals
  );

  recordTrade({
    timestamp: Date.now(),
    tokenIn: pair.inSymbol,
    tokenOut: pair.outSymbol,
    tokenInAddress: isQuoteCurrency(pair.tokenIn) ? undefined : pair.tokenIn,
    tokenOutAddress: isQuoteCurrency(pair.tokenOut) ? undefined : pair.tokenOut,
    amountIn: params.amountIn,
    amountOut: received,
    usdValue: tradeUsd,
    tier: pair.tier,
    txHash,
  });

  return {
    txHash,
    explorerUrl: `${BLOCKSCOUT}/tx/${txHash}`,
    sold: params.amountIn,
    received,
    inSymbol: pair.inSymbol,
    outSymbol: pair.outSymbol,
    usdValue: tradeUsd,
    tier: pair.tier,
    offHoursNote: market && !market.open ? `${market.detail}. ${OFF_HOURS_WARNING}` : null,
  };
}

export interface SendParams {
  token: string;
  to: string;
  amount: string;
}

export interface SendResult {
  txHash: string;
  explorerUrl: string;
  symbol: string;
  amount: string;
  to: Address;
  usdValue: number;
}

/**
 * Guardrailed outbound transfer (withdrawal). Disabled by default policy;
 * when enabled, the recipient allowlist and USD limits run before signing.
 */
export async function executeSend(params: SendParams): Promise<SendResult> {
  const currency = resolveCurrency(params.token);
  const destination = getAddress(params.to.trim());
  if (destination.toLowerCase() === NATIVE.toLowerCase()) {
    throw new Error("Refusing to send to the zero address: those funds would be burned.");
  }
  if (destination.toLowerCase() === account.address.toLowerCase()) {
    throw new Error("Destination is this wallet itself; nothing to send.");
  }

  // Policy-enabled and allowlist checks need no chain data: run them before
  // any RPC so a disabled policy or bad recipient fails fast and offline.
  checkTransferAllowed(destination, 0);

  // Symbol/decimals: quotes are known, arbitrary tokens are profiled (which
  // also supplies the pools used to value the transfer in USD).
  let symbol: string;
  let decimals: number;
  let pools: PoolInfo[] = [];
  if (isNative(currency)) {
    symbol = "ETH";
    decimals = 18;
  } else if (currency.toLowerCase() === USDG.toLowerCase()) {
    symbol = "USDG";
    decimals = USDG_DECIMALS;
  } else {
    const p = await profileToken(currency);
    symbol = p.symbol;
    decimals = p.decimals;
    pools = p.pools;
  }
  const amountRaw = parseUnits(params.amount, decimals);
  if (amountRaw <= 0n) throw new Error("amount must be greater than zero.");

  // Value the transfer in USD and run the guardrails first: policy errors
  // (disabled, allowlist, caps) are the actionable ones, balance comes after.
  const transferUsd = await usdValue(currency, amountRaw, decimals, pools);
  checkTransferAllowed(destination, transferUsd);

  // Balance check, with a gas cushion when sending native ETH.
  const balance = await balanceOf(currency);
  const gasCushion = isNative(currency) ? parseUnits("0.0005", 18) : 0n;
  if (balance < amountRaw + gasCushion) {
    throw new Error(
      `Insufficient ${symbol}: have ${formatUnits(balance, decimals)}, ` +
        `need ${params.amount}${gasCushion > 0n ? " plus a small gas reserve" : ""}.`
    );
  }

  const txHash = isNative(currency)
    ? await walletClient.sendTransaction({ to: destination, value: amountRaw })
    : await walletClient.writeContract({
        address: currency,
        abi: erc20Abi,
        functionName: "transfer",
        args: [destination, amountRaw],
      });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Transfer transaction reverted: ${BLOCKSCOUT}/tx/${txHash}`);
  }

  recordTransfer({
    timestamp: Date.now(),
    token: symbol,
    amount: params.amount,
    to: destination,
    usdValue: transferUsd,
    txHash,
  });

  return {
    txHash,
    explorerUrl: `${BLOCKSCOUT}/tx/${txHash}`,
    symbol,
    amount: params.amount,
    to: destination,
    usdValue: transferUsd,
  };
}

export interface Position {
  address: string;
  symbol: string;
  balance: string;
}

export interface Portfolio {
  address: Address;
  eth: string;
  ethUsd: number | null;
  ethUsdPrice: number | null;
  usdg: string;
  /** Live balances of tokens this wallet previously traded. */
  positions: Position[];
  funded: boolean;
}

/** Current holdings: ETH, USDG, and live balances of previously traded tokens. */
export async function getPortfolio(): Promise<Portfolio> {
  const eth = await publicClient.getBalance({ address: account.address });
  let price: number | null = null;
  try {
    price = await ethUsdPrice();
  } catch {
    // pricing pools unreachable: report the raw balance only
  }
  const usdg = await publicClient.readContract({
    address: USDG,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  // Previously traded token addresses, deduped, newest first.
  const seen = new Map<string, string>();
  for (const t of tradeHistory(200)) {
    for (const [addr, sym] of [
      [t.tokenInAddress, t.tokenIn],
      [t.tokenOutAddress, t.tokenOut],
    ] as const) {
      if (addr && !seen.has(addr.toLowerCase())) seen.set(addr.toLowerCase(), sym);
    }
  }

  const positions: Position[] = [];
  for (const [addr, sym] of seen) {
    try {
      const address = getAddress(addr);
      const [balance, decimals] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      if (balance > 0n) {
        positions.push({ address, symbol: sym, balance: formatUnits(balance, decimals) });
      }
    } catch {
      // token unreadable (selfdestructed, RPC hiccup): skip it
    }
  }

  const ethFloat = Number(formatUnits(eth, 18));
  return {
    address: account.address,
    eth: formatUnits(eth, 18),
    ethUsd: price !== null ? ethFloat * price : null,
    ethUsdPrice: price,
    usdg: formatUnits(usdg, USDG_DECIMALS),
    positions,
    funded: eth > 0n,
  };
}
