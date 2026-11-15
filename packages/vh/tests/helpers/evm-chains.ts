import type { ListedChain, TrustClass } from "../../src/originals/evm-internal.js";

/**
 * Made-up chains for an anchor pin's `chains` override (`EvmAnchorPin.chains`).
 *
 * EXPERIMENTAL (originals-spec PR 59 ce19572, owner decision of 14 November 2026): P14.22 lists one
 * chain, Base, a proven chain, so no move between EVM chains is possible under the spec's own list.
 * The trust classes, the layers and the up-only move rules stay in the spec for a later revision
 * (P9.27, P9.28, P14.22), and the tests exercise them on these rows, one per class. Their chain IDs
 * and block-0 hashes are not those of any real chain, and they are never in `EVM_CHAINS`.
 */
const row = (name: string, id: number, cls: TrustClass): ListedChain =>
  Object.freeze({ name, chain: `eip155:${id}`, chainId: BigInt(id), genesisHash: "0x" + id.toString(16).padStart(64, "0"), classes: Object.freeze([Object.freeze({ from: Date.UTC(2026, 10, 11), class: cls })]) });

/** `operator`: an attested chain. */
export const OPERATOR_CHAIN = row("Test operator chain", 990001, "operator");
/** `consortium`: an attested chain. */
export const CONSORTIUM_CHAIN = row("Test consortium chain", 990002, "consortium");
/** `consensus`: a proven chain. */
export const CONSENSUS_CHAIN = row("Test consensus chain", 990003, "consensus");
/** `exit-protected`: a proven rollup whose blocks can share a timestamp and its parent chain's block number. */
export const ROLLUP_CHAIN = row("Test rollup", 990004, "exit-protected");

export const TEST_CHAINS: ReadonlyArray<ListedChain> = Object.freeze([OPERATOR_CHAIN, CONSORTIUM_CHAIN, CONSENSUS_CHAIN, ROLLUP_CHAIN]);
