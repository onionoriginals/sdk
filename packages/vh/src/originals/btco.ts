/**
 * The did:btco alias that names an Original's anchoring sat (plan 012 §3.1,
 * §3.5; owner decision Q15). The network prefixes `sig:`, `test:` and `reg:`
 * are this profile's, as the SDK uses them (P9.10, P14.12; owner decision, D6;
 * spec PR #50 (open)).
 */
import { fail } from "../errors.js";

export type BitcoinNetwork = "mainnet" | "signet" | "testnet" | "regtest";

/** The largest sat number (did:btco method v0.2.0). */
export const MAX_SAT = 2_099_999_997_689_999n;

const PREFIX: Record<string, BitcoinNetwork> = { "": "mainnet", "sig:": "signet", "test:": "testnet", "reg:": "regtest" };

export interface BtcoAlias {
  did: string;
  network: BitcoinNetwork;
  /** Canonical decimal sat number. */
  sat: string;
}

/**
 * Parse `did:btco[:sig|:test|:reg]:<sat>`, or throw STATE_ALIASES (P9.10, P14.12).
 * The did:btco method v0.2.0 does not yet define network prefixes; this grammar
 * is proposed upstream as decentralized-identity/labs-ordinals-plus#4 [S30].
 */
export function parseBtcoAlias(did: string): BtcoAlias {
  const m = /^did:btco:((?:sig|test|reg):)?(0|[1-9]\d{0,15})$/.exec(did);
  if (!m || BigInt(m[2]) > MAX_SAT) fail("invalid-evidence", "STATE_ALIASES", `${did} is not a did:btco naming a sat`);
  return { did, network: PREFIX[m[1] ?? ""], sat: m[2] };
}

export function btcoAliasOf(aliases: readonly string[]): string | undefined {
  return aliases.find((a) => a.startsWith("did:btco:"));
}
