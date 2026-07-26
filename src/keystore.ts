import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/** All pouch state (wallet, trade history, optional config) lives here. */
export const POUCH_HOME = process.env.POUCH_HOME ?? join(homedir(), ".pouch");

const walletPath = join(POUCH_HOME, "wallet.json");

export interface WalletInfo {
  privateKey: Hex;
  address: Address;
  source: "env" | "file" | "generated";
  path?: string;
}

/**
 * Resolve the pouch key: env var wins (bring your own key), then the local
 * keystore, and if neither exists a fresh wallet is generated on the spot.
 * The key is never exposed through MCP tools; export is a human-run CLI command.
 */
export function loadOrCreateWallet(): WalletInfo {
  const env = process.env.POUCH_PRIVATE_KEY;
  if (env) {
    return {
      privateKey: env as Hex,
      address: privateKeyToAccount(env as Hex).address,
      source: "env",
    };
  }

  if (existsSync(walletPath)) {
    const data = JSON.parse(readFileSync(walletPath, "utf8")) as { privateKey: Hex };
    return {
      privateKey: data.privateKey,
      address: privateKeyToAccount(data.privateKey).address,
      source: "file",
      path: walletPath,
    };
  }

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  mkdirSync(POUCH_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(
    walletPath,
    JSON.stringify({ privateKey, address, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  return { privateKey, address, source: "generated", path: walletPath };
}
