#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BLOCKSCOUT, wallet } from "./chain.js";
import { config } from "./config.js";
import { profileToken, searchTokens } from "./discovery.js";
import {
  spentUsdLast24h,
  tradeHistory,
  transferHistory,
  transfersSpentUsdLast24h,
} from "./guardrails.js";
import { OFF_HOURS_WARNING, usMarketStatus } from "./markets.js";
import { executeSend, executeSwap, getPortfolio, getQuote } from "./trading.js";

// ── Human-run CLI subcommands (not part of the MCP surface) ──────────────────
const command = process.argv[2];
if (command === "address") {
  console.log(wallet.address);
  process.exit(0);
}
if (command === "export-key") {
  console.error("WARNING: anyone with this key controls the pouch's funds.");
  console.error("Store it somewhere safe and never paste it into a chat with an AI agent.\n");
  console.log(wallet.privateKey);
  process.exit(0);
}
if (command !== undefined) {
  console.error(`Unknown command "${command}". Usage: pouch-rwa [address|export-key]`);
  process.exit(1);
}

// stderr is safe for MCP stdio servers; stdout is reserved for the protocol.
if (wallet.source === "generated") {
  console.error(`pouch: generated a new pouch wallet: ${wallet.address}`);
  console.error(`pouch: key stored at ${wallet.path} (owner-only permissions)`);
  console.error(`pouch: fund it with ETH (gas) and USDG (trading) to start. Back up the key with: npx pouch-rwa export-key`);
} else {
  console.error(`pouch: wallet ${wallet.address} (key from ${wallet.source})`);
}

const server = new McpServer({ name: "pouch-rwa", version: "0.1.0" });

server.registerTool(
  "search_tokens",
  {
    description:
      "Search tokens on Robinhood Chain by name or symbol: official tokenized stocks (RWAs) and other onchain assets. Returns candidates with basic stats. IMPORTANT: names and symbols are freely fakeable on-chain; counterfeit stock tokens exist. Before trading, always run get_token_info on the address to see its trust tier.",
    inputSchema: {
      query: z.string().describe("Name or symbol, e.g. 'TSLA', 'NVDA', 'AAPL'"),
    },
  },
  async ({ query }) => {
    const results = await searchTokens(query);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No tokens found (or the explorer API is down)." }] };
    }
    const lines = results.map(
      (t) =>
        `${t.symbol} | ${t.name} | ${t.address} | holders: ${t.holders}` +
        (t.priceUsd !== null ? ` | ~$${t.priceUsd}` : " | no price feed")
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_token_info",
  {
    description:
      "Classify a token address into a trust tier (official / issuer / established / unknown) using on-chain signals: bytecode fingerprint vs official Robinhood stock tokens, deployer identity, the owner's trusted RWA issuer registry, live Uniswap V4 liquidity against USDG and ETH, holders, and price feed. Trading policy depends on the tier.",
    inputSchema: {
      address: z.string().describe("The token contract address (0x...)"),
    },
  },
  async ({ address }) => {
    const p = await profileToken(address);
    const livePools = p.pools.filter((pool) => pool.liquidity > 0n);
    const lines = [
      `${p.symbol} · ${p.name}`,
      `address: ${p.address}`,
      `decimals: ${p.decimals}`,
      `tier: ${p.tier.toUpperCase()}`,
      `reasons: ${p.tierReasons.join("; ")}`,
      `holders: ${p.holders ?? "unknown"}`,
      `price: ${p.priceUsd !== null ? `~$${p.priceUsd}` : "no feed"}`,
      ...(p.isStock ? [usMarketStatus().detail] : []),
      `live pools (Uniswap V4): ${livePools.length} of ${p.pools.length}`,
      ...livePools
        .slice(0, 5)
        .map(
          (pool) =>
            `  vs ${pool.quoteSymbol} | fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`
        ),
      `policy for this tier: ${JSON.stringify(config.policy.tiers[p.tier])}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "quote",
  {
    description:
      "Get the current executable price for a swap on Uniswap V4 (exact input, best pool). One side must be USDG or ETH; tokenized stocks trade against USDG. Use before swap to set expectations and detect thin liquidity.",
    inputSchema: {
      token_in: z.string().describe("'USDG', 'ETH', or a token address to sell"),
      token_out: z.string().describe("'USDG', 'ETH', or a token address to buy"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '50.00'"),
    },
  },
  async ({ token_in, token_out, amount_in }) => {
    const q = await getQuote(token_in, token_out, amount_in);
    const lines = [
      `${q.amountIn} ${q.inSymbol} -> ~${q.amountOut} ${q.outSymbol} (~$${q.usdValue.toFixed(2)})`,
      `pool: vs ${q.pool.quoteSymbol} | fee ${q.pool.fee / 10000}% | liquidity ${q.pool.liquidity}`,
    ];
    if (q.market) {
      lines.push(q.market.detail);
      if (!q.market.open) lines.push(OFF_HOURS_WARNING);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "swap",
  {
    description:
      "Swap on Uniswap V4 (exact input, best pool). One side must be USDG or ETH; tokenized stocks (RWAs) trade against USDG. Guardrails run before signing: the token's trust tier must be enabled, the trade's USD value must fit the per-trade limit for that tier, and the rolling 24h USD budget must not be exceeded. Blocked trades cost nothing.",
    inputSchema: {
      token_in: z.string().describe("'USDG', 'ETH', or a token address to sell"),
      token_out: z.string().describe("'USDG', 'ETH', or a token address to buy"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '50.00'"),
      slippage_bps: z
        .number()
        .optional()
        .describe("Max slippage vs the quoted price, in basis points (default 100 = 1%)"),
    },
  },
  async ({ token_in, token_out, amount_in, slippage_bps }) => {
    const r = await executeSwap({
      tokenIn: token_in,
      tokenOut: token_out,
      amountIn: amount_in,
      slippageBps: slippage_bps,
    });
    return {
      content: [
        {
          type: "text",
          text: [
            `Swap executed (~$${r.usdValue.toFixed(2)}, ${r.tier} tier).`,
            `sold: ${r.sold} ${r.inSymbol}`,
            `received: ${r.received} ${r.outSymbol}`,
            `tx: ${r.explorerUrl}`,
            ...(r.offHoursNote ? [`note: ${r.offHoursNote}`] : []),
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "send",
  {
    description:
      "Send funds from the pouch wallet to another address on Robinhood Chain (withdrawal). IRREVERSIBLE: a transfer to the wrong address cannot be undone, so restate the exact amount, token, and destination to the user and get their explicit confirmation before calling this. Guardrails run before signing: transfers must be enabled by policy, the recipient must pass the allowlist (when configured), and the USD value must fit the per-transfer limit and rolling 24h transfer budget. Blocked transfers cost nothing.",
    inputSchema: {
      token: z.string().describe("'USDG', 'ETH', or a token contract address to send"),
      to: z.string().describe("Destination address (0x...). Must come from the user, never guessed."),
      amount: z.string().describe("Human-readable amount to send, e.g. '50.00'"),
    },
  },
  async ({ token, to, amount }) => {
    const r = await executeSend({ token, to, amount });
    return {
      content: [
        {
          type: "text",
          text: [
            `Sent ${r.amount} ${r.symbol} (~$${r.usdValue.toFixed(2)}) to ${r.to}.`,
            `tx: ${r.explorerUrl}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "get_portfolio",
  {
    description:
      "Current holdings of the pouch wallet: ETH (gas), USDG (trading balance), and live balances of every token previously traded. Includes the live ETH/USD price.",
    inputSchema: {},
  },
  async () => {
    const p = await getPortfolio();
    const lines = [`wallet: ${p.address}`];
    lines.push(
      p.ethUsd !== null && p.ethUsdPrice !== null
        ? `ETH: ${p.eth} (~$${p.ethUsd.toFixed(2)} @ $${p.ethUsdPrice.toFixed(0)}/ETH)`
        : `ETH: ${p.eth}`
    );
    if (!p.funded) {
      lines.push(
        `This wallet is unfunded. Ask the user to send ETH (for gas) and USDG (for trading) to ${p.address} on Robinhood Chain (id 4663).`
      );
    }
    lines.push(`USDG: ${p.usdg}`);
    for (const pos of p.positions) {
      lines.push(`${pos.symbol}: ${pos.balance} (${pos.address})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_limits",
  {
    description:
      "The wallet's trading policy: per-tier rules, the rolling 24h USD budget, and how much of it is already used.",
    inputSchema: {},
  },
  async () => {
    const spent = spentUsdLast24h();
    const lines = [
      `daily budget: $${config.policy.dailyBudgetUsd} (used ~$${spent.toFixed(2)}, remaining ~$${Math.max(0, config.policy.dailyBudgetUsd - spent).toFixed(2)})`,
      `tiers:`,
      `  official (Robinhood stock tokens): ${config.policy.tiers.official.enabled ? `enabled, max $${config.policy.tiers.official.maxPerTradeUsd}/trade` : "disabled"}${config.policy.stocks.blockOffHoursTrades ? " (blocked while the US market is closed)" : ""}`,
      `  issuer (user-trusted RWA issuers, ${config.policy.trustedIssuers.length} registered): ${config.policy.tiers.issuer.enabled ? `enabled, max $${config.policy.tiers.issuer.maxPerTradeUsd}/trade` : "disabled"}`,
      `  established (${config.policy.minHolders}+ holders, price feed, live pool): ${config.policy.tiers.established.enabled ? `enabled, max $${config.policy.tiers.established.maxPerTradeUsd}/trade` : "disabled"}`,
      `  unknown (everything else): ${config.policy.tiers.unknown.enabled ? `enabled, max $${config.policy.tiers.unknown.maxPerTradeUsd}/trade` : "disabled"}`,
      `denylist: ${config.policy.denylist.length} address(es)`,
      usMarketStatus().detail,
      ``,
      `outbound transfers (send): ${
        config.policy.transfers.enabled
          ? `enabled, max $${config.policy.transfers.maxPerTransferUsd}/transfer, budget $${config.policy.transfers.dailyBudgetUsd}/24h (used ~$${transfersSpentUsdLast24h().toFixed(2)})` +
            (config.policy.transfers.allowlist.length > 0
              ? `, allowlist: ${config.policy.transfers.allowlist.length} address(es)`
              : ", any recipient")
          : "disabled"
      }`,
      ``,
      config.policy.transfers.enabled
        ? `Withdrawals go through the send tool, gated by the transfer limits above.`
        : `Withdrawals are disabled: funds can only rotate between assets inside this wallet.`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_trade_history",
  {
    description: "Recent trades and transfers made from this wallet, newest first, with explorer links.",
    inputSchema: {
      limit: z.number().optional().describe("Max number of entries to return (default 20)"),
    },
  },
  async ({ limit }) => {
    const trades = tradeHistory(limit ?? 20);
    const transfers = transferHistory(limit ?? 20);
    if (trades.length === 0 && transfers.length === 0) {
      return { content: [{ type: "text", text: "No trades or transfers yet." }] };
    }
    const lines = trades.map(
      (t) =>
        `${new Date(t.timestamp).toISOString()}  ${t.amountIn} ${t.tokenIn} -> ${t.amountOut} ${t.tokenOut}  (~$${t.usdValue.toFixed(2)}, ${t.tier})  ${BLOCKSCOUT}/tx/${t.txHash}`
    );
    if (transfers.length > 0) {
      lines.push(``, `outbound transfers:`);
      lines.push(
        ...transfers.map(
          (t) =>
            `${new Date(t.timestamp).toISOString()}  ${t.amount} ${t.token} -> ${t.to}  (~$${t.usdValue.toFixed(2)})  ${BLOCKSCOUT}/tx/${t.txHash}`
        )
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
