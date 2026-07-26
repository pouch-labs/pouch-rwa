# pouch-rwa

**The RWA trading wallet for AI agents on Robinhood Chain.**

pouch gives an autonomous agent a self-custodial wallet it can trade tokenized real-world assets from — official Robinhood stock tokens, 24/7, through Uniswap V4 — inside hard limits the owner sets. Every trade is valued in USD and checked against policy *before* anything is signed. A blocked trade costs nothing.

It ships as two things in one package:

- **An MCP server** — plug it into Claude, ChatGPT, Cursor, or any MCP-capable agent.
- **A TypeScript SDK** — build fully autonomous trading agents on the same guardrailed engine.

> Experimental software. Not audited, not financial advice. Fund the pouch only with what you can afford to lose. Independent project, not affiliated with or endorsed by Robinhood.

## Setup (MCP)

```bash
# 1. Connect your agent (a fresh pouch wallet is generated on first run)
claude mcp add pouch -- npx -y pouch-rwa

# 2. See the address and fund it: ETH for gas, USDG for trading
npx -y pouch-rwa address
```

That's the whole setup. Back up the key anytime with `npx pouch-rwa export-key` (the key is never exposed to the agent).

## SDK

```ts
import { Pouch } from "pouch-rwa";

const pouch = new Pouch();

// find the real tokenized TSLA among the fakes
const results = await pouch.search("TSLA");
for (const candidate of results) {
  const profile = await pouch.profile(candidate.address);
  if (profile.tier === "official") {
    // bytecode-verified Robinhood stock token with live USDG liquidity
    await pouch.buyUsd(profile.address, 50); // $50, guardrails enforced
    break;
  }
}

console.log(await pouch.portfolio());
```

The `Pouch` class covers the common loop: `search`, `profile`, `quote`, `swap`, `buyUsd`, `sell`, `portfolio`, `limits`, `trades`. The lower-level building blocks (`profileToken`, `bestQuote`, `swapV4`, `checkTradeAllowed`, …) are exported too.

## How it stays safe

- **Trust tiers.** Names are free to fake; signals aren't. Every address is classified on-chain before the agent can touch it:
  - `official` — runtime bytecode matches the fingerprint shared by the official Robinhood stock tokens, deployer cross-checked, live Uniswap V4 liquidity against USDG.
  - `issuer` — matches an entry in your trusted RWA issuer registry (`policy.trustedIssuers`).
  - `established` — 1000+ holders, an indexed price feed, real pool liquidity.
  - `unknown` — everything else, blocked by default. This is where the counterfeit TSLAs live.
- **Policy before signatures.** Per-trade USD limits by tier, a rolling 24h budget, and a denylist — all checked before signing. Blocked trades throw a readable reason and cost nothing.
- **No withdrawal by default.** Funds rotate between assets inside the pouch; outbound transfers are opt-in policy with their own allowlist and limits.
- **Market-hours aware.** Stock tokens trade 24/7 but NYSE doesn't; off-hours trades warn (or block, via `policy.stocks.blockOffHoursTrades`) because pool prices can drift from the last close.
- **Key isolation.** The key lives in `~/.pouch/wallet.json` (or `POUCH_PRIVATE_KEY`), is never shown to the model, and export is a human-run CLI command.

## Configuration

Policy loads from `POUCH_CONFIG`, `./pouch.config.json`, or `~/.pouch/config.json` — see [pouch.config.example.json](pouch.config.example.json) for the defaults. Environment: `POUCH_HOME` (state directory), `POUCH_PRIVATE_KEY` (bring your own key), `POUCH_CONFIG` (explicit config path).

## MCP tools

| Tool | What it does |
| --- | --- |
| `search_tokens` | Find tokens by name/symbol (names are fakeable — always classify next) |
| `get_token_info` | Trust-tier classification with reasons |
| `quote` | Executable price, best pool, market-hours status |
| `swap` | Guardrailed exact-input swap via the Universal Router |
| `send` | Guardrailed withdrawal (disabled by default policy) |
| `get_portfolio` | ETH, USDG, and live balances of traded positions |
| `get_limits` | Active policy and rolling 24h budget usage |
| `get_trade_history` | Recent trades and transfers with explorer links |

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev   # run the MCP server from source
```

MIT © pouch labs
