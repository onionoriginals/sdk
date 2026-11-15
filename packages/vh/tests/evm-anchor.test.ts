/**
 * EVM anchoring, the verifier (originals-spec PR 59, proposed, EXPERIMENTAL):
 * reading a token's publication records at the finalized block (P9.21,
 * P9.22, P9.25, P14.20), the P9.12-P9.17 rules under the readings of P9.20,
 * ownership (P9.23), anchors and uniqueness (P9.24), trust classes (P9.27),
 * moves (P9.28, P9.29), copies (P7.14) and did:evm resolution (P3.9, P14.18).
 *
 * Section 12 rows are cited by C12 id, followed by the start of the row's
 * first column. Contract-revert rows belong to the contract's own tests.
 */
import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../src/log/index.js";
import { canonicalize, type JsonValue } from "../src/json/index.js";
import {
  EVM_CHAINS,
  createOriginal,
  derivedTokenAlias,
  parseBtcoAlias,
  parseEvmAlias,
  readInscribedEntries,
  isEvmCheckpoint,
  resolveDidEvm,
  resumableCheckpoint,
  updateOriginal,
  verifyOriginal,
  carriedDisclosure,
  readCarriedFile,
  writeCarriedFile,
  type EvmAnchorPin,
  type EvmProviderRead,
  type EvmRecord,
  type EvmTokenEvidence,
  type ListedChain,
  type OriginalsReport,
  type RetainedEvmBlock,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/evm-internal.js";
import { CONSENSUS_CHAIN, CONSORTIUM_CHAIN, OPERATOR_CHAIN, ROLLUP_CHAIN, TEST_CHAINS } from "./helpers/evm-chains.js";
import { VhAuthor, bytes, carrying, clock, describedBytes, photo, seeded } from "./helpers/originals.js";

// P14.22 lists only Base (originals-spec PR 59 ce19572); the pin adds made-up chains of the other classes
// so the class and layer rules the spec keeps for a later revision stay exercised (P9.27, P9.28).
const PIN: EvmAnchorPin = { address: "0x" + "ab".repeat(20), codeHash: "0x" + "c0".repeat(32), chains: [...EVM_CHAINS, ...TEST_CHAINS] };
/** The spec's own list: Base alone (P14.22). */
const SPEC_CHAINS_PIN: EvmAnchorPin = { address: PIN.address, codeHash: PIN.codeHash };
const OPERATOR = OPERATOR_CHAIN.chain; // operator: attested
const CONSORTIUM = CONSORTIUM_CHAIN.chain; // consortium: attested
const CONSENSUS = CONSENSUS_CHAIN.chain; // consensus: proven
const BASE = "eip155:8453"; // exit-protected: proven; the one chain P14.22 lists
const A = "0x" + "11".repeat(20); // Alice, minter on the first chain
const C = "0x" + "22".repeat(20); // Carol, minter on the destination
const HOLDER = "0x" + "33".repeat(20);
const CAROL = "0x" + "44".repeat(20);
const SAT = "did:btco:reg:5000000000";
const NOW = Date.parse("2026-10-19T00:00:00Z");
/** Record timestamps, seconds: an hour after the entries were signed. */
const TS0 = Date.parse("2026-10-18T13:00:00Z") / 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");

const listed = (chain: string, pin: EvmAnchorPin = PIN): ListedChain => (pin.chains ?? EVM_CHAINS).find((c) => c.chain === chain)!;
const blockHash = (chain: string, n: number, salt = 0) => "0x" + (BigInt(chain.slice(7)) * 1_000_000n + BigInt(n) + BigInt(salt) * 7n).toString(16).padStart(64, "0");

/** A publication record carrying `entries`, its body the last entry's resource version (P14.20). */
function rec(index: number, entries: LogEntry | LogEntry[], timestamp = TS0 + index * 12, extra: Partial<EvmRecord> = {}): EvmRecord {
  const c = carrying(entries);
  const metadata = c.metadata as Uint8Array;
  return { index, timestamp, metadataLength: metadata.length, bodyLength: c.content.length, bodyOf: index, mediaType: c.mediaType, metadata, body: c.content, ...extra };
}

/** A `publishSameBody` record: its own metadata, the body of record `of` (P14.20). */
function sameBody(index: number, entries: LogEntry | LogEntry[], of: EvmRecord, timestamp = TS0 + index * 12): EvmRecord {
  const metadata = carrying(entries).metadata as Uint8Array;
  return { index, timestamp, metadataLength: metadata.length, bodyLength: of.bodyLength, bodyOf: of.index, mediaType: of.mediaType, metadata, body: of.body };
}

type ReadOptions = Partial<Omit<EvmProviderRead, "records">> & { pin?: EvmAnchorPin };
/** One provider's read of a token at its finalized block (P9.21, P9.22). */
function read(chain: string, records: EvmRecord[] | null, o: ReadOptions = {}): EvmProviderRead {
  const l = listed(chain, o.pin);
  const finalized = o.finalized ?? 1000;
  return {
    provider: o.provider ?? "rpc-a",
    chainId: o.chainId ?? l.chainId,
    genesisHash: o.genesisHash ?? l.genesisHash,
    finalized,
    block: o.block ?? { number: finalized, hash: blockHash(chain, finalized) },
    codeHash: o.codeHash === undefined ? PIN.codeHash : o.codeHash,
    owner: o.owner === undefined ? HOLDER : o.owner,
    records,
    ...(o.observed ? { observed: o.observed } : {}),
    ...(o.blockHashes ? { blockHashes: o.blockHashes } : {}),
  };
}

/** Two independent providers that agree (P9.22). */
const two = (chain: string, records: EvmRecord[] | null, o: ReadOptions = {}) => [read(chain, records, { ...o, provider: "rpc-a" }), read(chain, records, { ...o, provider: "rpc-b" })];
const token = (alias: string, reads: EvmProviderRead[], chain = parseEvmAlias(alias).chain): EvmTokenEvidence => ({ chain, alias, reads });

/** An Original anchored from its genesis on `chain`: genesis, a new version, then the anchoring entry. */
async function original(chain = OPERATOR, seed = 41) {
  const key = seeded(seed);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  const at = clock();
  const sign = alice.signer(key, "orig");
  const author = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: photo(`dusk v1 ${seed}`), author, sign, anchor: { chain, minter: A }, evm: PIN });
  const id = (genesis.state as { id: string }).id;
  const alias = derivedTokenAlias(id, { chain, minter: A }, PIN);
  const v2 = await updateOriginal(genesis, { versionTime: at(), author, sign, resource: photo(`dusk v2 ${seed}`), evm: PIN });
  const anchoring = await updateOriginal(v2, { versionTime: at(), author, sign, aliases: [alias], evm: PIN });
  const log = [genesis, v2, anchoring];
  const next = (previous: LogEntry, input: Omit<Parameters<typeof updateOriginal>[1], "versionTime" | "author" | "sign"> = {}, versionTime = at()) =>
    updateOriginal(previous, { versionTime, author, sign, evm: PIN, ...input });
  return { alice, key, at, sign, author, genesis, v2, anchoring, log, id, alias, next };
}

type Extra = Partial<Parameters<typeof verifyOriginal>[0]>;
function verify(alice: VhAuthor, tokens: EvmTokenEvidence[], log?: LogEntry[], extra: Extra & { pin?: EvmAnchorPin | null; retained?: RetainedEvmBlock[] } = {}): Promise<OriginalsReport> {
  const { pin, retained, ...rest } = extra;
  return verifyOriginal({
    ...(log ? { log } : {}),
    authors: [alice.evidence()],
    now: NOW,
    bytes: (d) => describedBytes(d),
    evm: { pin: pin === undefined ? PIN : pin, tokens, ...(retained ? { retained } : {}) },
    ...rest,
  });
}

const missingEvidence = (r: OriginalsReport) => {
  expect(r.evm?.status).toBe("unverified");
  expect(r.reasons).toContain("evm-evidence-missing");
  expect(r.current).toBe(false);
};

describe("P9.27 the report of an Original anchored on an EVM chain", () => {
  test("C12-279 (changed at 1b5c484): 'Report for an Original anchored on an EVM chain': names the chain, its class, the token, the finalized block and the providers its read came from, marked uncorroborated when only one answered; never a Bitcoin anchor", async () => {
    const o = await original();
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))]);
    expect(r.history.status).toBe("valid");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.anchoring).toBeNull();
    expect(r.ownership).toBeNull();
    expect(r.ordering).toBe("evm-attested-by-operator");
    const s = r.evm!.stretches[0];
    expect(s).toMatchObject({ chain: OPERATOR, name: OPERATOR_CHAIN.name, class: "operator", layer: "attested", token: o.alias, block: { number: 1000, hash: blockHash(OPERATOR, 1000) }, providers: ["rpc-a", "rpc-b"], uncorroborated: false });
    expect(s.caip19).toBe(`${OPERATOR}/erc721:${PIN.address}/${parseEvmAlias(o.alias).tokenId}`);
    expect(r.evm!.owner).toMatchObject({ address: HOLDER, chain: OPERATOR, class: "operator", describes: "attested-by-operator", token: o.alias, block: { number: 1000 }, providers: ["rpc-a", "rpc-b"], uncorroborated: false });
    expect(s.uniqueness).toMatchObject({ status: "attested-by-operator", providers: ["rpc-a", "rpc-b"], uncorroborated: false });
    // P9.22 (1b5c484): a read only one usable provider answered is named and marked uncorroborated.
    const one = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)])])]);
    expect(one.evm!.stretches[0]).toMatchObject({ providers: ["rpc-a"], uncorroborated: true });
    expect(one.evm!.owner).toMatchObject({ providers: ["rpc-a"], uncorroborated: true });
    expect(one.evm!.stretches[0].uniqueness).toMatchObject({ providers: ["rpc-a"], uncorroborated: true });
    expect(s.entries).toEqual([o.anchoring.versionId]);
    expect(s.carried).toEqual([o.genesis.versionId, o.v2.versionId]);
    // The body of the anchoring publication is the current version, read from the chain (P9.25).
    expect(r.resources.versions[1]).toMatchObject({ bytes: "verified", onBitcoin: false, onEvm: OPERATOR });
    expect(r.retain.evm).toEqual([{ chain: OPERATOR, number: 1000, hash: blockHash(OPERATOR, 1000) }]);
  });

  test("C12-280: 'Report for an Original anchored on a consortium or operator chain': attested by its validators or operator, never proven", async () => {
    const tempo = await original(CONSORTIUM, 42);
    const r = await verify(tempo.alice, [token(tempo.alias, two(CONSORTIUM, [rec(0, tempo.log)]))]);
    expect(r.ordering).toBe("evm-attested-by-validators");
    // P9.24 as changed at a3ffdc1: uniqueness in the terms of the class.
    expect(r.evm!.stretches[0].uniqueness).toMatchObject({ status: "attested-by-validators", class: "consortium", chain: CONSORTIUM });
    expect(r.evm!.owner?.describes).toBe("attested-by-validators");
    const eth = await original(CONSENSUS, 43);
    const p = await verify(eth.alice, [token(eth.alias, two(CONSENSUS, [rec(0, eth.log)]))]);
    expect(p.ordering).toBe("evm-proven");
    expect(p.evm!.owner?.describes).toBe("proven");
    expect(p.evm!.stretches[0].uniqueness).toMatchObject({ status: "established", class: "consensus" });
  });
});

describe("support: section 14, P9.19, P9.21", () => {
  test("C12-239: 'Genesis entry with an anchor member while P14.21 pins no contract': unsupported, not invalid; nothing verified", async () => {
    const o = await original();
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], o.log, { pin: null });
    expect(r.history.status).toBe("unsupported");
    expect(r.history.failure).toMatchObject({ category: "unsupported-profile", code: "EVM_NO_ANCHOR_CONTRACT" });
    expect(r.evm?.status).toBe("unsupported");
    expect(r.validAsOf).toBeNull();
    expect(r.state).toBeNull();
    expect(r.current).toBe(false);
  });

  test("C12-288: 'Carried log with an anchor member naming a chain the reader's revision does not list, or read while P14.21 pins no contract': unsupported; nothing verified", async () => {
    const o = await original();
    // A log with no token evidence at all, as a carried log is read: still unsupported without a pin.
    const unpinned = await verifyOriginal({ log: o.log, authors: [o.alice.evidence()], now: NOW });
    expect(unpinned.history.status).toBe("unsupported");
    expect(unpinned.validAsOf).toBeNull();
    // A revision of P14.22 without the chain the Original names: unsupported, not invalid (P9.19).
    const without: EvmAnchorPin = { ...PIN, chains: PIN.chains!.filter((c) => c.chain !== OPERATOR) };
    const r = await verify(o.alice, [], o.log, { pin: without });
    expect(r.history.status).toBe("unsupported");
    expect(r.history.failure?.code).toBe("EVM_CHAIN_NOT_LISTED");
    expect(r.validAsOf).toBeNull();
  });

  test("C12-242: 'The pinned contract deployed on a chain that is not listed': unsupported", async () => {
    const optimism: ListedChain = { name: "OP Mainnet", chain: "eip155:10", chainId: 10n, genesisHash: "0x" + "7a".repeat(32), classes: [{ from: 0, class: "exit-protected" }] };
    const devnet: EvmAnchorPin = { ...PIN, chains: [...PIN.chains!, optimism] };
    const key = seeded(44);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const genesis = await createOriginal({ versionTime: clock()(), name: "x", resource: photo("x44"), author: alice.ref("orig"), sign: alice.signer(key, "orig"), anchor: { chain: "eip155:10", minter: A }, evm: devnet });
    const alias = derivedTokenAlias((genesis.state as { id: string }).id, { chain: "eip155:10", minter: A }, PIN);
    // Providers serve the chain and the pinned code is there, but this verifier's P14.22 does not list it.
    const r = await verify(alice, [token(alias, two("eip155:10", [rec(0, genesis)], { pin: devnet }))], [genesis]);
    expect(r.history.status).toBe("unsupported");
    expect(r.evm?.unsupported).toMatchObject({ code: "EVM_CHAIN_NOT_LISTED", chain: "eip155:10" });
  });

  test("C12-241: 'Code at the anchor contract address with another runtime code hash, or none': unsupported; never verified or not anchored", async () => {
    const o = await original();
    for (const codeHash of ["0x" + "ee".repeat(32), null]) {
      const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)], { codeHash }))], o.log);
      expect(r.history.status).toBe("unsupported");
      expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_ANCHOR_CODE_MISMATCH" } });
      expect(r.reasons).not.toContain("anchor-not-found-on-evm");
      expect(r.current).toBe(false);
    }
  });

  test("C12-240: 'Provider reporting the listed chain ID whose block 0 has another hash': not that chain; its answers are not evidence", async () => {
    const o = await original();
    const impostor = read(OPERATOR, [rec(0, o.log)], { provider: "rpc-fake", genesisHash: "0x" + "99".repeat(32), owner: CAROL });
    // With an honest provider beside it, the impostor is excluded, not a disagreement.
    const r = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)]), impostor])]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0].excludedProviders).toEqual([{ provider: "rpc-fake", reason: "wrong-genesis-hash" }]);
    expect(r.evm!.owner?.address).toBe(HOLDER);
    // Alone, it leaves the evidence missing.
    const alone = await verify(o.alice, [token(o.alias, [impostor])], o.log);
    missingEvidence(alone);
    expect(alone.evm!.stretches[0].missing?.code).toBe("EVM_NO_PROVIDER");
  });

  test("C12-243: 'Publication read from a chain other than the one anchor names': not a publication of the Original", async () => {
    const o = await original();
    // The token's alias, but read from another listed chain, where the same contract may also be deployed (P9.20).
    const r = await verify(o.alice, [token(o.alias, two(CONSENSUS, [rec(0, o.log)]), CONSENSUS)], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].excludedProviders.map((x) => x.reason)).toEqual(["other-chain", "other-chain"]);
    expect(r.history.entries).toBe(2); // only what precedes the anchoring entry (P7.14)
  });
});

describe("P9.22 finality and providers", () => {
  test("C12-244: 'Publication record present at the latest block but not in state at the finalized block': observed, not accepted; pending", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Harbor at dusk, cropped" });
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)], { observed: [rec(1, e4)] }))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].observed).toEqual([{ index: 1, timestamp: TS0 + 12 }]);
    expect(r.evm!.stretches[0].ignored).toContainEqual({ index: 1, reason: "observed-not-finalized" });
    expect(r.current).toBe(true); // the finalized state is current as of its block
  });

  test("C12-245 (changed at 1b5c484): 'Two usable providers report different hashes for the lower of their finalized blocks, or a different record, bytes or ownerOf': missing evidence until they agree; neither is dropped to reach a result", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const ok = [rec(0, o.log), rec(1, e4)];
    const cases: EvmProviderRead[][] = [
      [read(OPERATOR, ok), read(OPERATOR, ok, { provider: "rpc-b", block: { number: 1000, hash: blockHash(OPERATOR, 1000, 1) } })],
      [read(OPERATOR, ok), read(OPERATOR, [rec(0, o.log)], { provider: "rpc-b" })],
      [read(OPERATOR, ok), read(OPERATOR, [rec(0, o.log), { ...rec(1, e4), body: bytes("other bytes") }], { provider: "rpc-b" })],
      [read(OPERATOR, ok), read(OPERATOR, ok, { provider: "rpc-b", owner: CAROL })],
    ];
    for (const reads of cases) {
      const r = await verify(o.alice, [token(o.alias, reads)], o.log);
      missingEvidence(r);
      expect(r.evm!.stretches[0].missing?.code).toBe("EVM_PROVIDERS_DISAGREE");
      // P9.22: neither provider is dropped to settle it; both are named.
      expect(r.evm!.stretches[0].excludedProviders).toEqual([]);
      expect(r.evm!.stretches[0].providers).toEqual(["rpc-a", "rpc-b"]);
      expect(r.evm!.owner).toBeNull();
      expect(r.history.entries).toBe(2);
    }
  });

  test("C12-246: 'One provider's finalized block is N and the other's is N+1, and they agree on block N': verified at block N", async () => {
    const o = await original();
    const at1000 = { number: 1000, hash: blockHash(OPERATOR, 1000) };
    const r = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)], { finalized: 1000 }), read(OPERATOR, [rec(0, o.log)], { provider: "rpc-b", finalized: 1001, block: at1000 })])]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0].block).toEqual(at1000);
    // A reader that read the ahead provider at its own finalized block did not read block N from both.
    const unread = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)], { finalized: 1000 }), read(OPERATOR, [rec(0, o.log)], { provider: "rpc-b", finalized: 1001 })])], o.log);
    missingEvidence(unread);
  });

  test("C12-247: 'A block accepted as finalized is replaced': authoritative-source-changed and a finality failure", async () => {
    const o = await original();
    const tokens = [token(o.alias, two(OPERATOR, [rec(0, o.log)], { finalized: 1200, blockHashes: [{ number: 1000, hash: blockHash(OPERATOR, 1000, 5) }] }))];
    const r = await verify(o.alice, tokens, undefined, { retained: [{ chain: OPERATOR, number: 1000, hash: blockHash(OPERATOR, 1000) }] });
    expect(r.evm!.stretches[0].finality).toBe("failed");
    expect(r.evm!.warnings).toEqual(["authoritative-source-changed"]);
    expect(r.reasons).toEqual(expect.arrayContaining(["authoritative-source-changed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
    expect(r.evm!.owner).toBeNull();
    // The same block, unreplaced, holds.
    const held = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], undefined, { retained: [{ chain: OPERATOR, number: 1000, hash: blockHash(OPERATOR, 1000) }] });
    expect(held.evm!.stretches[0].finality).toBe("held");
    expect(held.current).toBe(true);
  });
});

describe("P9.23, P9.24 ownership and the anchor", () => {
  test("C12-248: 'Token minted, no anchoring publication': not anchored; no owner", async () => {
    const o = await original();
    for (const records of [[], [rec(0, [o.genesis, o.v2])]]) {
      const r = await verify(o.alice, [token(o.alias, two(OPERATOR, records))], o.log);
      expect(r.evm?.status).toBe("not-anchored");
      expect(r.evm?.owner).toBeNull();
      expect(r.reasons).toContain("anchor-not-found-on-evm");
      expect(r.current).toBe(false);
    }
  });

  test("C12-264: 'Token held by a contract account': that contract is the owner", async () => {
    const o = await original();
    const safe = "0x" + "5a".repeat(20); // a multisig contract; ownerOf does not say which
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)], { owner: safe }))]);
    expect(r.evm!.owner?.address).toBe(safe);
  });

  test("C12-249 (changed at a3ffdc1), C12-294: 'Two anchoring entries from different branches published on the token' and 'Fork of an Original with an EVM anchor, then an anchoring entry accepted': the lower index is the anchor and settles the fork; uniqueness attested by the operator", async () => {
    const o = await original();
    const v2b = await o.next(o.genesis, { name: "Harbor at night" });
    const anchoringB = await o.next(v2b, { aliases: [o.alias] });
    const branchB = [o.genesis, v2b, anchoringB];
    // The supplied copy and a second copy are the two branches of the fork (P6.6).
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, branchB), rec(1, o.log)]))], o.log, { copies: [{ source: "other", log: branchB.map((e) => JSON.stringify(e) + "\n").join("") }] });
    const s = r.evm!.stretches[0];
    expect(s.anchor).toMatchObject({ index: 0, versionId: anchoringB.versionId });
    expect(s.conflicting).toEqual([expect.objectContaining({ index: 1, versionId: o.anchoring.versionId })]);
    expect(r.head).toBe(anchoringB.versionId);
    expect(r.fork).toBeNull();
    expect(s.uniqueness).toEqual({ status: "attested-by-operator", chain: OPERATOR, class: "operator", block: { number: 1000, hash: blockHash(OPERATOR, 1000) }, providers: ["rpc-a", "rpc-b"], uncorroborated: false });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-250: 'Two publications extending the same head, recorded in one block or in different blocks': the lower record index is accepted", async () => {
    const o = await original();
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(o.anchoring, { name: "B" });
    for (const tsB of [TS0 + 12, TS0 + 24]) {
      const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, a, TS0 + 12), rec(2, b, tsB)]))]);
      expect(r.head).toBe(a.versionId);
      expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "does-not-extend-head" }));
    }
  });

  test("C12-251: 'Two successive publications, the second extending the first, recorded in one block': both accepted, in index order", async () => {
    const o = await original();
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(a, { name: "B" });
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log, TS0), rec(1, a, TS0), rec(2, b, TS0)]))]);
    expect(r.head).toBe(b.versionId);
    expect(r.evm!.stretches[0].accepted.map((p) => p.index)).toEqual([1, 2]);
    expect(r.current).toBe(true);
  });

  test("C12-251: '…or in two blocks of a rollup that share one parent-chain block number': both accepted, in index order (P9.13, P9.20, P14.20)", async () => {
    // A rollup such as an Arbitrum chain: its blocks can share a timestamp and a contract sees its parent
    // chain's approximate block number [S38]. A record holds no block number, only its index and timestamp (P14.20), so two
    // rollup blocks behind one parent-chain block are, to the verifier, the index order and nothing else.
    const ROLLUP = ROLLUP_CHAIN.chain;
    expect(listed(ROLLUP)).toBeDefined();
    const o = await original(ROLLUP, 47);
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(a, { name: "B" });
    const records = [rec(0, o.log, TS0), rec(1, a, TS0 + 1), rec(2, b, TS0 + 1)];
    for (const r of records) expect(Object.keys(r).some((k) => /block/i.test(k))).toBe(false);
    const r = await verify(o.alice, [token(o.alias, two(ROLLUP, records))]);
    expect(r.head).toBe(b.versionId);
    expect(r.evm!.stretches[0].accepted.map((p) => [p.index, p.versionId])).toEqual([[1, a.versionId], [2, b.versionId]]);
    expect(r.evm!.stretches[0].ignored).toEqual([]);
    // The second publication extends the first, so index order decides; a later record that does not extend the head is not accepted.
    const stale = await o.next(o.anchoring, { name: "C" });
    const forked = await verify(o.alice, [token(o.alias, two(ROLLUP, [...records, rec(3, stale, TS0 + 1)]))]);
    expect(forked.head).toBe(b.versionId);
    expect(forked.evm!.stretches[0].accepted.map((p) => p.index)).toEqual([1, 2]);
  });
});

describe("P9.25, P14.20 records and bytes", () => {
  test("C12-255: 'Record whose length fields exceed 350,000 bytes, as a provider reports it, after valid earlier records': rejected from its fields; history resolves; not missing", async () => {
    const o = await original();
    const huge: EvmRecord = { index: 1, timestamp: TS0 + 12, metadataLength: 350_001, bodyLength: 0, bodyOf: 1, mediaType: "image/jpeg" };
    const longType: EvmRecord = { index: 2, timestamp: TS0 + 24, metadataLength: 10, bodyLength: 10, bodyOf: 2, mediaType: "x".repeat(256) };
    const sameBodyHuge: EvmRecord = { index: 3, timestamp: TS0 + 36, metadataLength: 350_001, bodyLength: 5, bodyOf: 0, mediaType: "image/jpeg" };
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), huge, longType, sameBodyHuge]))]);
    expect(r.evm?.status).toBe("anchored");
    expect(r.evm!.stretches[0].ignored).toEqual([
      { index: 1, reason: "too-large" }, { index: 2, reason: "media-type-too-long" }, { index: 3, reason: "too-large" },
    ]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-256: 'Record of 350,000 bytes that is no valid publication, after valid earlier records': read and rejected; the earlier history resolves", async () => {
    const o = await original();
    const body = bytes("0123456789");
    const metadata = new Uint8Array(350_000 - body.length).fill(0xff); // not one well-formed CBOR item (P14.12)
    const junk: EvmRecord = { index: 1, timestamp: TS0 + 12, metadataLength: metadata.length, bodyLength: body.length, bodyOf: 1, mediaType: "image/jpeg", metadata, body };
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), junk]))]);
    expect(r.evm!.stretches[0].ignored).toEqual([expect.objectContaining({ index: 1, reason: "undecodable" })]);
    expect(r.current).toBe(true);
  });

  test("C12-257: 'Publication whose body digest, size or media type differs from the last entry's descriptor': rejected", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const wrongBody = { ...rec(1, e4), body: bytes("not the photograph"), bodyLength: 18 };
    const wrongType = { ...rec(1, e4), mediaType: "image/png" };
    for (const [bad, reason] of [[wrongBody, "body-not-the-resource"], [wrongType, "content-type-mismatch"]] as const) {
      const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), bad]))]);
      expect(r.head).toBe(o.anchoring.versionId);
      expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason }));
    }
  });

  test("C12-258: 'Publication that refers to an earlier record's body, the last entry not changing the resource': accepted, the body checked as if stored", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const first = rec(0, o.log);
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [first, sameBody(1, e4, first)]))]);
    expect(r.head).toBe(e4.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-259: 'Publication that refers to an earlier record's body whose digest differs from the last entry's descriptor': rejected", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { resource: photo("dusk v3") });
    const first = rec(0, o.log);
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [first, sameBody(1, e4, first)]))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason: "body-not-the-resource" }));
  });

  test("C12-261: 'Publication known only from a Published event, or a token whose records or bytes cannot be read from state': resolution fails with missing evidence", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    // Records not read (a reader that found the publication only through an event has no record).
    missingEvidence(await verify(o.alice, [token(o.alias, two(OPERATOR, null))], o.log));
    // A record whose bytes were not read: never decided on the part that was (P9.25).
    const unread = { ...rec(1, e4), metadata: undefined, body: undefined };
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), unread]))], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].missing?.code).toBe("EVM_RECORD_BYTES_UNREAD");
    expect(r.history.entries).toBe(2);
  });
});

describe("P9.15 with the inscription time of P9.20, P9.26", () => {
  test("C12-263: 'did:webvh signer key removed before the timestamp the publication's record holds': rejected, as P9.15", async () => {
    // A did:vh signer; P9.15 treats did:vh and did:webvh alike.
    const o = await original();
    o.alice.timeOverride = iso(TS0 - 600);
    await o.alice.rotate([{ fragment: "next", signer: seeded(49) }]);
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], o.log);
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 0, reason: "author-key-not-valid-at-inscription-time" }));
    // The record's inscription time is the greatest timestamp so far: an earlier timestamp on a later record does not reach back.
    const p = await original(OPERATOR, 50);
    const e4 = await p.next(p.anchoring, { name: "late" });
    p.alice.timeOverride = iso(TS0 + 30);
    await p.alice.rotate([{ fragment: "next", signer: seeded(51) }]);
    // Record 2 holds an earlier timestamp than record 1; its inscription time is record 1's, after the removal.
    const later = await verify(p.alice, [token(p.alias, two(OPERATOR, [rec(0, p.log, TS0), rec(1, p.genesis, TS0 + 60), rec(2, e4, TS0 + 20)]))]);
    expect(later.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "author-key-not-valid-at-inscription-time" }));
    expect(later.head).toBe(p.anchoring.versionId);
  });

  test("C12-293: 'Entry published on an Original's token, whose signer later removes the signing key': remains current; not historically authorized only; not claimed", async () => {
    const o = await original();
    o.alice.timeOverride = iso(TS0 + 3600);
    await o.alice.rotate([{ fragment: "next", signer: seeded(52) }]);
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.historicallyAuthorizedOnly).toEqual([]);
    expect(r.ordering).toBe("evm-attested-by-operator");
  });
});

describe("P14.13 the entry limit on a publication", () => {
  test("C12-150: \"Entry whose JCS form is 65,536 / 65,537 UTF-8 bytes, in `did.jsonl`, an inscription, a publication or any carrier\": accepted / rejected, in an EVM publication", async () => {
    const key = seeded(77);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const author = alice.ref("orig");
    const atSize = async (target: number) => {
      let pad = 65_000;
      for (let i = 0; i < 40; i++) {
        const genesis = await createOriginal({ versionTime: at(), name: "Harbor", metadata: { pad: "a".repeat(pad) }, resource: photo("limit"), author, sign, anchor: { chain: OPERATOR, minter: A }, evm: PIN });
        const size = new TextEncoder().encode(canonicalize(genesis as unknown as JsonValue)).length;
        if (size === target) {
          const id = (genesis.state as { id: string }).id;
          const alias = derivedTokenAlias(id, { chain: OPERATOR, minter: A }, PIN);
          const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, metadata: null, aliases: [alias], evm: PIN });
          return { log: [genesis, anchoring], alias, anchoring };
        }
        pad += target - size;
      }
      throw new Error(`no entry of ${target} bytes`);
    };
    const fits = await atSize(65_536);
    const ok = await verify(alice, [token(fits.alias, two(OPERATOR, [rec(0, fits.log)]))]);
    expect(ok.evm?.status, JSON.stringify(ok.evm?.stretches[0]?.ignored)).toBe("anchored");
    expect(ok.head).toBe(fits.anchoring.versionId);
    const over = await atSize(65_537);
    const r = await verify(alice, [token(over.alias, two(OPERATOR, [rec(0, over.log)]))]);
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm?.stretches[0]?.ignored).toEqual([expect.objectContaining({ index: 0, code: "ENTRY_TOO_LARGE" })]);
    expect(r.current).toBe(false);
  });
});

describe("P7.14 copies of the log", () => {
  test("C12-287: 'Carried file of an Original whose log has an anchor member, the chain readable': state from the token; the copy not preferred; chain and class named", async () => {
    const o = await original();
    const unpublished = await o.next(o.anchoring, { name: "Draft name" });
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], [...o.log, unpublished]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.state?.name).toBe("Harbor at dusk");
    expect(r.evm!.stretches[0]).toMatchObject({ chain: OPERATOR, class: "operator" });
    expect(r.current).toBe(true);
  });

  test("C12-287, C12-234: carried file read through readCarriedFile, the chain readable / not read: verified from the token / evm-unread, missing evidence (P7.14)", async () => {
    const o = await original();
    const d = (o.anchoring.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
    const file = await writeCarriedFile(describedBytes(d)!, o.log, { disclosed: carriedDisclosure(o.log) });
    const read = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)]))] } });
    expect(read.anchoring.status).toBe("evm");
    expect(read.verified, JSON.stringify(read.reasons)).toEqual({ log: true, version: true });
    expect(read.current).toBe(true);
    expect(read.report?.evm?.stretches[0]).toMatchObject({ chain: OPERATOR, class: "operator" });
    const unread = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [] } });
    expect(unread.anchoring.status).toBe("evm-unread");
    expect(unread.anchoring.notCheckedAgainstAnchor).toEqual([o.anchoring.versionId]);
    expect(unread.verified).toEqual({ log: false, version: false });
    expect(unread.current).toBe(false);
    expect(unread.reasons).toContain("evm-evidence-missing");
    const nopin = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW });
    expect(nopin.anchoring.status).toBe("unsupported");
  });

  test("C12-317: 'Carried checkpoint from before the anchoring entry of an Original that is now anchored': allowed; a historical checkpoint, valid as of it, with no statement about current anchoring, even though the anchor member would let the token be derived (P7.14, P7.15)", async () => {
    const o = await original();
    const d = (o.v2.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
    const file = await writeCarriedFile(describedBytes(d)!, [o.genesis, o.v2], { disclosed: carriedDisclosure([o.genesis, o.v2]) });
    // With the token readable and showing the Original anchored, and with nothing read: the same report.
    for (const tokens of [[token(o.alias, two(OPERATOR, [rec(0, o.log)]))], []]) {
      const r = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
      expect(r.anchoring).toEqual({ status: "historical-checkpoint", notCheckedAgainstAnchor: [] });
      expect(r.verified, JSON.stringify(r.reasons)).toEqual({ log: true, version: true });
      expect(r.overall).toEqual({ status: "verified", reason: null });
      expect(r.validAsOf?.checkpoint).toBe(o.v2.versionId);
      expect(r.current).toBe(false);
      // No token was read: the verifier's own detail has no anchored stretch, and the carried report uses none of it.
      expect(r.report?.evm?.stretches.every((s) => s.status !== "anchored" && s.providers.length === 0)).toBe(true);
      expect(r.reasons).not.toEqual(expect.arrayContaining(["evm-evidence-missing"]));
      expect(r.reasons).not.toContain("anchor-not-found-on-evm");
      expect(r.statements.join(" ")).toContain("makes no statement about whether the Original has been anchored since");
    }
  });

  test("C12-297: 'Complete evidence package of an anchored Original, read without access to the anchor': missing evidence; at most the entries before the first anchoring entry", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const r = await verify(o.alice, [], [...o.log, e4]);
    missingEvidence(r);
    expect(r.history).toMatchObject({ status: "valid", entries: 2 });
    expect(r.head).toBe(o.v2.versionId);
    expect(r.ordering).toBe("claimed");
    expect(r.validAsOf?.checkpoint).toBe(o.v2.versionId);
  });
});

/** A Bitcoin index's read of a sat, its inscriptions placed there (P9.10). */
function satRead(inscriptions: Array<Omit<SatInscription, "sat" | "network">>, owner: SatEvidence["owner"] = { output: "aa".repeat(32) + ":0", confirmations: 3 }): SatEvidence {
  const { sat, network } = parseBtcoAlias(SAT);
  return { sat: SAT, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat, network, ...i })), owner };
}

/** An Original anchored on `from` (the test operator chain by default), with a move entry to `to` (an EVM chain, or Bitcoin when null). */
async function moving(to: string | null = CONSENSUS, seed = 61, from = OPERATOR) {
  const o = await original(from, seed);
  const dest = to ? derivedTokenAlias(o.id, { chain: to, minter: C }, PIN) : SAT;
  const move = await o.next(o.anchoring, to ? { anchor: { chain: to, minter: C }, aliases: [dest] } : { anchor: null, aliases: [SAT] });
  const through = [...o.log, move];
  return { ...o, dest, move, through };
}

describe("P9.28, P9.29 moves", () => {
  test("C12-265 (changed at ce19572): 'Move entry from Base to Bitcoin, departed and arrived; under a revision of P14.22 that lists an attested chain, a move entry from it to a proven chain or to Bitcoin, departed and arrived': anchored on the destination; the owner is its holder", async () => {
    const m = await moving(CONSENSUS);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ]);
    expect(r.evm).toMatchObject({ status: "anchored", move: "confirmed" });
    expect(r.evm!.owner).toMatchObject({ address: CAROL, chain: CONSENSUS, describes: "proven" });
    expect(r.head).toBe(m.move.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);

    const b = await moving(null, 62);
    const btc = await verify(b.alice, [token(b.alias, two(OPERATOR, [rec(0, b.log), rec(1, b.move)]))], undefined, {
      bitcoin: [satRead([{ id: "ab".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(b.through) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(btc.evm).toMatchObject({ status: "moved-to-bitcoin", move: "confirmed", owner: null });
    expect(btc.anchoring).toMatchObject({ status: "anchored", sat: SAT });
    expect(btc.ownership).toMatchObject({ status: "provisional", sat: SAT });
    // The move entry keeps the ordering of the stretch it was accepted on (P9.29).
    expect(btc.ordering).toBe("evm-attested-by-operator");
    expect(btc.current, JSON.stringify(btc.reasons)).toBe(true);
    // Reports stay separate: with no copy of the log supplied, the Bitcoin report names none, as from a sat alone
    // (found on regtest, scripts/regtest/originals-evm-move.ts); a supplied copy is compared.
    expect(btc.anchoring).toMatchObject({ copy: "absent", superseded: 0 });
    const withCopy = await verify(b.alice, [token(b.alias, two(OPERATOR, [rec(0, b.log), rec(1, b.move)]))], b.through, {
      bitcoin: [satRead([{ id: "ab".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(b.through) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(withCopy.anchoring).toMatchObject({ status: "anchored", copy: "agrees" });

    // C12-265 (changed at ce19572): from Base, the one chain P14.22 lists, to Bitcoin, under the spec's own list.
    const fromBase = await moving(null, 66, BASE);
    const onBitcoin = await verify(fromBase.alice, [token(fromBase.alias, two(BASE, [rec(0, fromBase.log), rec(1, fromBase.move)], { pin: SPEC_CHAINS_PIN }))], undefined, {
      pin: SPEC_CHAINS_PIN,
      bitcoin: [satRead([{ id: "ac".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(fromBase.through) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(onBitcoin.evm).toMatchObject({ status: "moved-to-bitcoin", move: "confirmed", owner: null });
    expect(onBitcoin.evm!.stretches[0]).toMatchObject({ chain: BASE, class: "exit-protected", describes: "proven" });
    expect(onBitcoin.anchoring).toMatchObject({ status: "anchored", sat: SAT });
    expect(onBitcoin.ordering).toBe("evm-proven");
    expect(onBitcoin.current, JSON.stringify(onBitcoin.reasons)).toBe(true);
  });

  test("C12-276 (changed at ce19572): 'Under a revision of P14.22 that lists an attested chain, report for an Original that moved from it to a proven chain' (the test pin lists one): both chains, their classes and entries; the earlier stretch attested", async () => {
    const m = await moving(CONSENSUS, 63);
    const e5 = await m.next(m.move, { name: "On the consensus chain" });
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600), rec(1, e5, TS0 + 612)], { owner: CAROL })),
    ]);
    const [left, here] = r.evm!.stretches;
    expect(left).toMatchObject({ chain: OPERATOR, class: "operator", describes: "attested-by-operator", entries: [m.anchoring.versionId, m.move.versionId], providers: ["rpc-a", "rpc-b"], block: { number: 1000 } });
    expect(left.departure).toMatchObject({ index: 1, versionId: m.move.versionId, destination: m.dest });
    expect(here).toMatchObject({ chain: CONSENSUS, class: "consensus", describes: "proven", arrival: true, entries: [e5.versionId], carried: m.through.map((e) => e.versionId) });
    expect(r.ordering).toBe("evm-proven");
    expect(r.current).toBe(true);
  });

  test("C12-269: 'Arrival on the destination with no departure accepted on the chain left': not accepted; still anchored where it was", async () => {
    const m = await moving(CONSENSUS, 64);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: A })),
    ]);
    expect(r.evm!.stretches.map((s) => s.chain)).toEqual([OPERATOR]);
    expect(r.head).toBe(m.anchoring.versionId);
    expect(r.evm!.owner?.address).toBe(HOLDER);
  });

  test("C12-270: 'Departure accepted, no arrival yet': departed, not arrived; the move entry's state; no owner", async () => {
    const m = await moving(CONSENSUS, 65);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [], { owner: null })),
    ]);
    expect(r.evm).toMatchObject({ status: "departed-not-arrived", destination: m.dest, owner: null });
    expect(r.head).toBe(m.move.versionId);
    expect(r.state?.anchor).toEqual({ chain: CONSENSUS, minter: C });
    expect(r.reasons).toContain("departed-not-arrived");
    expect(r.current).toBe(false);
  });

  test("C12-271: 'Publication on the token left behind, after the departure': not accepted; reported", async () => {
    const m = await moving(CONSENSUS, 66);
    const stray = await m.next(m.move, { name: "Published on the old token" });
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move), rec(2, stray)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ]);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "after-departure" }));
    expect(r.head).toBe(m.move.versionId);
  });

  test("C12-272: 'Arrival whose log differs from the entries accepted through the departure, or whose last entry is not the move entry': not an arrival", async () => {
    const m = await moving(CONSENSUS, 67);
    const other = await m.next(m.anchoring, { anchor: { chain: CONSENSUS, minter: C }, aliases: [m.dest], name: "Another move entry" });
    for (const carried of [[...m.log, other], m.log]) {
      const r = await verify(m.alice, [
        token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
        token(m.dest, two(CONSENSUS, [rec(0, carried, TS0 + 600)], { owner: CAROL })),
      ]);
      expect(r.evm?.status).toBe("departed-not-arrived");
      expect(r.evm!.stretches[1].ignored).toContainEqual(expect.objectContaining({ index: 0, reason: "not-an-arrival" }));
    }
  });

  test("C12-273 (changed at a3ffdc1), C12-315: 'Carried log holding a move entry, the current chain read and a chain it left unreadable': proofs and hash links verified from genesis; move unconfirmed; that stretch's ordering claimed only; no owner and not current", async () => {
    const m = await moving(CONSENSUS, 68);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, null)),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], m.through);
    expect(r.history).toMatchObject({ status: "valid", entries: 4 });
    expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null });
    // P9.29: the entries accepted on the unread chain are neither attested nor proven.
    expect(r.evm!.stretches[0]).toMatchObject({ chain: OPERATOR, status: "unverified", ordering: "claimed", entries: [m.anchoring.versionId, m.move.versionId] });
    expect(r.ordering).toBe("claimed");
    expect(r.reasons).toContain("move-unconfirmed");
    expect(r.current).toBe(false);
  });

  test("C12-273: 'Moved Original, a chain it left cannot be read', arrived on Bitcoin and read from the sat alone: move unconfirmed; that stretch's ordering claimed; no owner and not current (found on regtest)", async () => {
    const b = await moving(null, 75);
    const sat = [satRead([{ id: "ab".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(b.through) } as Omit<SatInscription, "sat" | "network">])];
    // With a copy of the log, and with none: the sat carries the log, whose genesis entry has an `anchor` member (P9.17, P9.19).
    for (const log of [b.through, undefined]) {
      const r = await verify(b.alice, [], log, { bitcoin: sat });
      expect(r.history).toMatchObject({ status: "valid", entries: b.through.length });
      expect(r.head).toBe(b.move.versionId);
      expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null });
      expect(r.evm!.stretches[0]).toMatchObject({ chain: OPERATOR, status: "unverified", ordering: "claimed", entries: [b.anchoring.versionId, b.move.versionId] });
      expect(r.anchoring).toMatchObject({ status: "anchored", sat: SAT, copy: log ? "agrees" : "absent" });
      expect(r.ownership).toBeNull();
      expect(r.ordering).toBe("claimed");
      expect(r.reasons).toContain("move-unconfirmed");
      expect(r.current).toBe(false);
    }
    // P9.19, section 14: a verifier with no pin reports it unsupported, never as an Original anchored on Bitcoin alone.
    const unpinned = await verify(b.alice, [], undefined, { bitcoin: sat, pin: null });
    expect(unpinned.evm).toMatchObject({ status: "unsupported" });
    expect(unpinned.current).toBe(false);
  });

  test("C12-274: 'A chain the Original left later replaces the block that held the departure': finality failure there; move unconfirmed", async () => {
    const m = await moving(CONSENSUS, 69);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)], { finalized: 1100, blockHashes: [{ number: 1000, hash: blockHash(OPERATOR, 1000, 3) }] })),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { retained: [{ chain: OPERATOR, number: 1000, hash: blockHash(OPERATOR, 1000) }] });
    expect(r.evm!.stretches[0].finality).toBe("failed");
    expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null, warnings: ["authoritative-source-changed"] });
    expect(r.reasons).toEqual(expect.arrayContaining(["move-unconfirmed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
  });

  test("C12-289 (changed at a3ffdc1), C12-312 (changed at 1b5c484), C12-339: 'Departure final, destination chain cannot be read': departure finalized, destination unreachable; missing evidence; no arrival claimed or denied; at most the entries before the first anchoring entry; the entries through the move entry, though the chain left accepted them, not checked against the current anchor; no owner and nothing current", async () => {
    const m = await moving(CONSENSUS, 70);
    for (const dest of [[], [token(m.dest, two(CONSENSUS, null, { owner: CAROL }))]]) {
      const r = await verify(m.alice, [token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])), ...dest], m.through);
      missingEvidence(r);
      expect(r.history.entries).toBe(2);
      expect(r.evm).toMatchObject({ status: "unverified", destination: m.dest, arrival: "unknown", owner: null });
      expect(r.evm!.stretches[0].departure).toMatchObject({ index: 1, versionId: m.move.versionId, destination: m.dest });
      expect(r.evm!.stretches[0].block).toEqual({ number: 1000, hash: blockHash(OPERATOR, 1000) });
      expect(r.evm!.stretches[1]).toMatchObject({ token: m.dest, status: "unverified", missing: expect.objectContaining({ code: expect.any(String) }) });
      expect(r.reasons).toContain("evm-destination-unreachable");
      expect(r.reasons).not.toContain("departed-not-arrived");
      // P9.29, P7.14 (1b5c484): valid as of the checkpoint before the anchoring entry, with claimed ordering.
      expect(r.head).toBe(m.v2.versionId);
      expect(r.ordering).toBe("claimed");
      expect(r.state?.anchor).toEqual({ chain: OPERATOR, minter: A });
      expect(r.evm!.notCheckedAgainstAnchor).toEqual([m.anchoring.versionId, m.move.versionId]);
      expect(r.current).toBe(false);
    }
  });

  test("C12-275 (changed at ce19572): 'Under a revision of P14.22 that lists an attested chain, move made from it to a proven chain that a later revision reclassifies operator' (the test pin lists one): still accepted, judged at the departure; reported under the current class", async () => {
    const m = await moving(BASE, 71);
    const revised: EvmAnchorPin = {
      ...PIN,
      chains: PIN.chains!.map((c) => (c.chain !== BASE ? c : { ...c, classes: [{ from: Date.UTC(2026, 0, 1), class: "exit-protected" as const }, { from: Date.UTC(2026, 9, 20), class: "operator" as const }] })),
    };
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(BASE, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { pin: revised });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.evm?.status).toBe("anchored");
    expect(r.evm!.stretches[1]).toMatchObject({ chain: BASE, class: "operator", describes: "attested-by-operator" });
    expect(r.evm!.owner?.describes).toBe("attested-by-operator");
  });

  test("C12-268: 'Move entry to a chain the verifier's revision of P14.22 does not list': unsupported, not invalid", async () => {
    const optimism: ListedChain = { name: "OP Mainnet", chain: "eip155:10", chainId: 10n, genesisHash: "0x" + "7a".repeat(32), classes: [{ from: 0, class: "exit-protected" }] };
    const devnet: EvmAnchorPin = { ...PIN, chains: [...PIN.chains!, optimism] };
    const o = await original(OPERATOR, 72);
    const dest = derivedTokenAlias(o.id, { chain: "eip155:10", minter: C }, PIN);
    const move = await updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: "eip155:10", minter: C }, aliases: [dest], evm: devnet });
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, move)]))]);
    expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_CHAIN_NOT_LISTED" } });
    expect(r.history.status).not.toBe("invalid");
    expect(r.current).toBe(false);
  });

  test("C12-352: 'Genesis anchor member naming a chain other than Base, such as eip155:1 or eip155:4663': unsupported, not invalid (P9.19, P14.22)", async () => {
    // An Original whose genesis names a chain of the first list (D6), written under a pin that still listed it.
    for (const [chain, seed] of [["eip155:1", 141], ["eip155:4663", 142]] as const) {
      const removed: ListedChain = { name: "removed", chain, chainId: BigInt(chain.slice(7)), genesisHash: "0x" + "5e".repeat(32), classes: [{ from: 0, class: "operator" }] };
      const first: EvmAnchorPin = { ...SPEC_CHAINS_PIN, chains: [...EVM_CHAINS, removed] };
      const key = seeded(seed);
      const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
      const genesis = await createOriginal({ versionTime: clock()(), name: "x", resource: photo(`x${seed}`), author: alice.ref("orig"), sign: alice.signer(key, "orig"), anchor: { chain, minter: A }, evm: first });
      const alias = derivedTokenAlias((genesis.state as { id: string }).id, { chain, minter: A }, first);
      // Providers serve the chain with the pinned code, but the verifier's P14.22 is the spec's: Base alone.
      const r = await verify(alice, [token(alias, two(chain, [rec(0, genesis)], { pin: first }))], [genesis], { pin: SPEC_CHAINS_PIN });
      expect(r.history.status).toBe("unsupported");
      expect(r.history.status).not.toBe("invalid");
      expect(r.evm?.unsupported).toMatchObject({ code: "EVM_CHAIN_NOT_LISTED", chain });
      expect(r.validAsOf).toBeNull();
      expect(r.current).toBe(false);
    }
  });

  test("C12-354: 'Move entry from Base naming an EVM chain this revision does not list': unsupported, not invalid; Base moves only to Bitcoin (P9.19, P9.28, P14.22)", async () => {
    const o = await original(BASE, 143);
    // No listed chain is above Base, so a writer following P14.22 refuses this entry (evm-state.test.ts). It is made here
    // under another pin, one that lists eip155:1 and places Base below it, as a later revision could.
    const other: EvmAnchorPin = {
      ...SPEC_CHAINS_PIN,
      chains: [
        { ...listed(BASE, SPEC_CHAINS_PIN), classes: [{ from: 0, class: "operator" }] },
        { name: "unlisted", chain: "eip155:1", chainId: 1n, genesisHash: "0x" + "5f".repeat(32), classes: [{ from: 0, class: "consensus" }] },
      ],
    };
    const dest = derivedTokenAlias(o.id, { chain: "eip155:1", minter: C }, other);
    const move = await updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: "eip155:1", minter: C }, aliases: [dest], evm: other });
    const r = await verify(o.alice, [token(o.alias, two(BASE, [rec(0, o.log), rec(1, move)], { pin: SPEC_CHAINS_PIN }))], undefined, { pin: SPEC_CHAINS_PIN });
    expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_CHAIN_NOT_LISTED" } });
    expect(r.history.status).not.toBe("invalid");
    expect(r.current).toBe(false);
  });

  test("C12-354 (review): a move whose destination holds other code at the pinned address is unsupported, never a valid empty history (section 14, section 7)", async () => {
    const m = await moving(CONSENSUS, 78);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { codeHash: "0x" + "ee".repeat(32) })),
    ]);
    expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_ANCHOR_CODE_MISMATCH" } });
    expect(r.history.status).not.toBe("valid");
    expect(r.current).toBe(false);
  });

  test("C12-295: 'Move entry's signing key removed, or its signer DID deactivated, after the departure and before the arrival': arrival accepted", async () => {
    for (const how of ["rotate", "deactivate"] as const) {
      const m = await moving(CONSENSUS, how === "rotate" ? 73 : 74);
      m.alice.timeOverride = iso(TS0 + 300);
      if (how === "rotate") await m.alice.rotate([{ fragment: "next", signer: seeded(75) }]);
      else await m.alice.deactivate();
      const r = await verify(m.alice, [
        token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
        token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
      ]);
      expect(r.evm?.status, how).toBe("anchored");
      expect(r.evm!.stretches[1].anchor?.versionId).toBe(m.move.versionId);
      expect(r.evm!.owner?.address).toBe(CAROL);
    }
  });

  test("C12-296: 'Move entry published as a departure when its signing key is not valid at the departure's inscription time': rejected; not departed", async () => {
    const m = await moving(CONSENSUS, 76);
    m.alice.timeOverride = iso(TS0 + 300);
    await m.alice.rotate([{ fragment: "next", signer: seeded(77) }]);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move, TS0 + 600)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 900)], { owner: CAROL })),
    ]);
    expect(r.evm!.stretches).toHaveLength(1);
    expect(r.evm!.stretches[0].departure).toBeNull();
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason: "author-key-not-valid-at-inscription-time" }));
    expect(r.head).toBe(m.anchoring.versionId);
  });

  test("C12-301: 'Original that moved to Bitcoin grants a did:btco editor in or after the move entry': accepted by the state rules", async () => {
    const o = await original(OPERATOR, 78);
    const grant = [{ did: "did:btco:reg:5", name: true, metadata: false, resource: false }];
    const move = await o.next(o.anchoring, { anchor: null, aliases: [SAT], editors: grant });
    expect((move.state as { asset: { editors?: unknown } }).asset.editors).toEqual(grant);
  });
});

describe("P3.9, P14.18 did:evm resolution", () => {
  test("C12-283: 'did:evm alias resolved, the log accepted on its token listing it': the did:vh, state and report; the document derived", async () => {
    const o = await original(OPERATOR, 81);
    const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)]))] } });
    expect(res.status).toBe("resolved");
    expect(res.original).toBe(o.id);
    expect(res.state?.aliases).toEqual([o.alias]);
    expect(res.chain).toEqual({ chain: OPERATOR, name: OPERATOR_CHAIN.name, class: "operator", describes: "attested-by-operator" });
    expect(res.document).toMatchObject({ id: o.alias, alsoKnownAs: [o.id], service: [expect.objectContaining({ id: `${o.alias}#files` })] });
    expect(res.report?.current).toBe(true);
  });

  test("C12-284: 'did:evm DID of a token with no accepted anchoring publication, or of a token whose accepted log does not list it': resolves to nothing", async () => {
    const o = await original(OPERATOR, 82);
    const minted = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, log: o.log, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, []))] } });
    expect(minted).toMatchObject({ status: "not-found", state: null, document: null });
    // Another token on the chain (another minter): the Original's accepted log does not list it.
    const other = derivedTokenAlias(o.id, { chain: OPERATOR, minter: C }, PIN);
    const notListed = await resolveDidEvm(other, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)])), token(other, two(OPERATOR, [rec(0, o.log)]))] } });
    expect(notListed.status).toBe("not-found");
    // Another contract: not an Originals anchor at all.
    const elsewhere = `did:evm:${OPERATOR_CHAIN.chainId}:0x${"cd".repeat(20)}:${parseEvmAlias(o.alias).tokenId}`;
    expect((await resolveDidEvm(elsewhere, { authors: [], evm: { pin: PIN, tokens: [] } })).status).toBe("not-found");
    // The form is the method's (P14.18).
    await expect(resolveDidEvm(o.alias.replace(PIN.address, PIN.address.toUpperCase().replace("0X", "0x")), { authors: [], evm: { pin: PIN, tokens: [] } })).rejects.toMatchObject({ code: "STATE_ALIASES" });
  });

  test("C12-285: 'did:evm DID of a token the Original has left': reported as moved, naming the alias that replaced it; no state on that token as current", async () => {
    const m = await moving(CONSENSUS, 83);
    const tokens = [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ];
    const left = await resolveDidEvm(m.alias, { authors: [m.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(left).toMatchObject({ status: "moved", original: m.id, replacedBy: m.dest, state: null, document: null });
    const here = await resolveDidEvm(m.dest, { authors: [m.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(here.status).toBe("resolved");
    expect(here.document).toMatchObject({ id: m.dest, alsoKnownAs: [m.id] });
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.22 providers and finality", () => {
  test("C12-325 (changed at 1b5c484): 'Provider that cannot serve state at the finalized block because finality trails its retained state': not usable; dropped, and the reads of the other usable providers stand; missing evidence only when none remains", async () => {
    const o = await original(OPERATOR, 101);
    const gone: EvmProviderRead = { ...read(OPERATOR, null, { provider: "rpc-b", codeHash: null, owner: null }), stateUnavailable: true };
    // Beside a provider that served it: dropped, and the other's read stands, uncorroborated (owner decision, 13 November 2026).
    const r = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)]), gone])], o.log);
    expect(r.evm?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0]).toMatchObject({ providers: ["rpc-a"], uncorroborated: true, excludedProviders: [{ provider: "rpc-b", reason: "state-unavailable" }] });
    expect(r.evm!.stretches[0].missing).toBeUndefined();
    // Alone, it leaves no usable provider: missing evidence, never unsupported for its absent code, never not anchored.
    const alone = await verify(o.alice, [token(o.alias, [gone])], o.log);
    missingEvidence(alone);
    expect(alone.evm!.stretches[0].missing?.code).toBe("EVM_STATE_UNAVAILABLE");
    expect(alone.evm!.status).not.toBe("unsupported");
    expect(alone.history.entries).toBe(2);
  });

  test("C12-326: 'Provider read at its own, later finalized block, compared with the other provider at the lower block': not evidence for the comparison", async () => {
    const o = await original(OPERATOR, 102);
    const r = await verify(o.alice, [token(o.alias, [
      read(OPERATOR, [rec(0, o.log)], { finalized: 1000 }),
      read(OPERATOR, [rec(0, o.log)], { provider: "rpc-b", finalized: 1004 }), // read at 1004, its own finalized block
    ])], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].missing?.code).toBe("EVM_READ_NOT_AT_FINALIZED");
  });

  test("C12-327: 'Verification repeated with no evidence of a finality failure': earlier finalized hashes need not be read again; when evidence appears, a warning, and retained results resting on that block are discarded", async () => {
    const o = await original(OPERATOR, 103);
    const e4 = await o.next(o.anchoring, { name: "Published on the replaced fork" });
    // A first verification at block 1000, on what later turns out to be a replaced fork.
    const first = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, e4)]))]);
    expect(first.current).toBe(true);
    const retained = { original: first.retain.original!, authors: first.retain.authors, anchor: first.retain.anchor! };
    const checkpoints = first.retain.evmCheckpoints!;
    expect(checkpoints).toEqual([expect.objectContaining({ chain: OPERATOR, contract: PIN.address, tokenId: String(parseEvmAlias(o.alias).tokenId), record: 1, block: { number: 1000, hash: blockHash(OPERATOR, 1000) }, head: e4.versionId, class: "operator" })]);
    // Later, at block 1200, with no evidence about block 1000: finality is assumed; nothing is re-read.
    const assumed = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, e4)], { finalized: 1200 }))], undefined, { retained: first.retain.evm! });
    expect(assumed.evm!.stretches[0].finality).toBe("unchecked");
    expect(assumed.evm!.warnings).toEqual([]);
    expect(assumed.current).toBe(true);
    // A provider reports another hash for block 1000: the fork that held record 1 was replaced.
    const replaced = blockHash(OPERATOR, 1000, 9);
    const r = await verifyOriginal({
      authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), retained,
      evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)], { finalized: 1200, blockHashes: [{ number: 1000, hash: replaced }] }))], retained: first.retain.evm, checkpoints },
    });
    expect(r.evm!.warnings).toEqual(["authoritative-source-changed"]);
    expect(r.evm!.stretches[0]).toMatchObject({ finality: "failed", uniqueness: { status: "not-established" } });
    expect(r.reasons).toEqual(expect.arrayContaining(["authoritative-source-changed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
    // Discarded: the retained head e4, the checkpoint at block 1000 and the block itself.
    expect(r.retain.original).toBe(o.anchoring.versionId);
    // Lower than the retained e4, so the report tells a store that never lowers to replace it (P9.22).
    expect(r.retain.discardOriginal).toBe(true);
    expect(first.retain.discardOriginal).toBeUndefined();
    expect(r.retain.evm).toEqual([{ chain: OPERATOR, number: 1200, hash: blockHash(OPERATOR, 1200) }]);
    expect(r.retain.evmCheckpoints ?? []).toEqual([]);
  });
});

describe("P9.25 checkpoints (originals-spec PR 59 1b5c484)", () => {
  /** An Original with three publications after its anchor; the first read verifies through e5 at record 2. */
  async function checkpointed(seed: number) {
    const o = await original(OPERATOR, seed);
    const e4 = await o.next(o.anchoring, { name: "Four" });
    const e5 = await o.next(e4, { name: "Five" });
    const e6 = await o.next(e5, { name: "Six" });
    const r0 = rec(0, o.log);
    const early = [r0, rec(1, e4), sameBody(2, e5, r0)];
    const first = await verify(o.alice, [token(o.alias, two(OPERATOR, early))]);
    const [cp] = first.retain.evmCheckpoints!;
    /** The records after the checkpoint's record index, read at a later block. */
    const later = (records: EvmRecord[], from = 3) => [token(o.alias, two(OPERATOR, records, { finalized: 1300 }).map((x) => ({ ...x, from })))];
    const resume = (log: LogEntry[], tokens: EvmTokenEvidence[], checkpoints: unknown[] = [cp]) =>
      verifyOriginal({ log, authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: PIN, tokens, checkpoints: checkpoints as typeof cp[] } });
    return { ...o, e4, e5, e6, r0, early, first, cp, later, resume };
  }

  test("C12-328 (changed at 1b5c484): 'Token with many records, verifier holding a checkpoint and a supplied log whose entry N has the checkpoint's versionId': MAY resume and read only the records after its record index; no record cap", async () => {
    const c = await checkpointed(104);
    expect(c.first.head).toBe(c.e5.versionId);
    // P9.25: the head entry's versionId, the chain (CAIP-2), the token (contract and token ID), the accepting record's
    // index, the finalized block's number and hash, and the chain's class at that block. No entries.
    expect(c.cp).toMatchObject({
      head: c.e5.versionId, chain: OPERATOR, contract: PIN.address, tokenId: String(parseEvmAlias(c.alias).tokenId), record: 2,
      block: { number: 1000, hash: blockHash(OPERATOR, 1000) }, class: "operator",
    });
    expect(JSON.stringify(c.cp)).not.toContain('"proof"');
    // Later: only records 3 and on are read, at a later block; record 3 refers to record 0's body.
    const resumed = await c.resume([...c.log, c.e4, c.e5], c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]));
    expect(resumed.history.status, JSON.stringify(resumed.history.failure)).toBe("valid");
    expect(resumed.head).toBe(c.e6.versionId);
    expect(resumed.current, JSON.stringify(resumed.reasons)).toBe(true);
    const s = resumed.evm!.stretches[0];
    expect(s.resumedFrom).toEqual({ head: c.e5.versionId, record: 2, block: c.cp.block });
    expect(s.anchor).toMatchObject({ index: 0, versionId: c.anchoring.versionId });
    expect(s.accepted.map((p) => [p.index, p.versionId])).toEqual([[1, c.e4.versionId], [2, c.e5.versionId], [3, c.e6.versionId]]);
    expect(resumed.retain.evmCheckpoints).toEqual([expect.objectContaining({ record: 3, head: c.e6.versionId, block: { number: 1300, hash: blockHash(OPERATOR, 1300) } })]);
    // Entries after line N in the supplied log are not evidence; the later records are.
    const e6b = await c.next(c.e5, { name: "Six, never published" });
    const extra = await c.resume([...c.log, c.e4, c.e5, e6b], c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]));
    expect(extra.head).toBe(c.e6.versionId);
    // A later read with no checkpoint is missing evidence, never decided on what was read.
    const none = await c.resume([...c.log, c.e4, c.e5], c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]), []);
    missingEvidence(none);
    expect(none.evm!.stretches[0].missing?.code).toBe("EVM_RECORDS_UNREADABLE");
  });

  test("C12-328: a checkpoint's record index is the record that accepted the head, not the count read: a rejected record after it is read again", async () => {
    const o = await original(OPERATOR, 106);
    const e4 = await o.next(o.anchoring, { name: "Four" });
    const e5 = await o.next(e4, { name: "Five" });
    const stray = await o.next(o.v2, { name: "Does not extend the head" });
    const first = await verify(o.alice, [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, e4), rec(2, stray)]))]);
    const [cp] = first.retain.evmCheckpoints!;
    expect(cp).toMatchObject({ head: e4.versionId, record: 1 });
    const r = await verifyOriginal({
      log: [...o.log, e4], authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d),
      evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(2, stray), rec(3, e5)], { finalized: 1300 }).map((x) => ({ ...x, from: 2 })))], checkpoints: [cp] },
    });
    expect(r.head).toBe(e5.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "does-not-extend-head" }));
  });

  test("C12-349: 'Checkpoint with a supplied log that ends before the checkpoint's versionId, or whose entry N has another entry hash': not resumed from; the token read from its first record", async () => {
    const c = await checkpointed(107);
    const other5 = await c.next(c.e4, { name: "Another five" });
    const records = c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]);
    for (const log of [[...c.log, c.e4], [...c.log, c.e4, other5]]) {
      // A read that resumed anyway is not evidence of the earlier records: missing evidence.
      const r = await c.resume(log, records);
      missingEvidence(r);
      expect(r.evm!.stretches[0].missing?.code).toBe("EVM_CHECKPOINT_UNUSABLE");
      expect(r.evm!.stretches[0].resumedFrom).toBeUndefined();
      // Read from the first record, the checkpoint is not needed and the token decides.
      const full = await c.resume(log, [token(c.alias, two(OPERATOR, [...c.early, sameBody(3, c.e6, c.r0, TS0 + 600)], { finalized: 1300 }))]);
      expect(full.head).toBe(c.e6.versionId);
      expect(full.evm!.stretches[0].resumedFrom).toBeUndefined();
      expect(full.current, JSON.stringify(full.reasons)).toBe(true);
    }
    // The resumer's choice (P9.25), exported for readers: only a log whose entry N has the head's versionId.
    expect(resumableCheckpoint([c.cp], c.alias, [...c.log, c.e4, c.e5])).toBe(c.cp);
    expect(resumableCheckpoint([c.cp], c.alias, [...c.log, c.e4, c.e5, c.e6])).toBe(c.cp);
    expect(resumableCheckpoint([c.cp], c.alias, [...c.log, c.e4])).toBeUndefined();
    expect(resumableCheckpoint([c.cp], c.alias, [...c.log, c.e4, other5])).toBeUndefined();
    // A versionId found at another line is not entry N.
    expect(resumableCheckpoint([c.cp], c.alias, [c.genesis, c.e4, c.e5] as LogEntry[])).toBeUndefined();
  });

  test("C12-350: 'Retained result lacking the head versionId, the chain, the contract address or token ID, the record index, the finalized block's number or hash, or the trust class at that block': not a checkpoint; not resumed from", async () => {
    const c = await checkpointed(108);
    expect(isEvmCheckpoint(c.cp)).toBe(true);
    const drop = (path: string[]): unknown => {
      const x = structuredClone(c.cp) as unknown as Record<string, Record<string, unknown>>;
      if (path.length === 1) delete (x as Record<string, unknown>)[path[0]];
      else delete x[path[0]][path[1]];
      return x;
    };
    for (const path of [["head"], ["chain"], ["contract"], ["tokenId"], ["record"], ["block", "number"], ["block", "hash"], ["block"], ["class"]]) {
      const broken = drop(path);
      expect(isEvmCheckpoint(broken), path.join(".")).toBe(false);
      const r = await c.resume([...c.log, c.e4, c.e5], c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]), [broken]);
      missingEvidence(r);
      expect(r.evm!.stretches[0].resumedFrom).toBeUndefined();
      // Nor is it retained for later (P9.25).
      expect(r.retain.evmCheckpoints ?? []).toEqual([]);
    }
    // Members that do not agree with one another are not a checkpoint either: a token ID of another Original.
    expect(isEvmCheckpoint({ ...c.cp, tokenId: "1" })).toBe(true); // form alone; the token must still be this one's
    const elsewhere = await c.resume([...c.log, c.e4, c.e5], c.later([sameBody(3, c.e6, c.r0, TS0 + 600)]), [{ ...c.cp, tokenId: "1" }]);
    missingEvidence(elsewhere);
  });

  test("C12-351: 'Verification during which a publication waits on an unverifiable entry': no checkpoint made", async () => {
    const o = await original(OPERATOR, 109);
    const older = o.alice.entries.slice();
    await o.alice.rotate([{ fragment: "orig", signer: o.key }, { fragment: "spare", signer: seeded(110) }]);
    const blocking = await updateOriginal(o.anchoring, { versionTime: o.at(), name: "Names a version the reader lacks", author: o.alice.ref("orig"), sign: o.alice.signer(o.key, "orig"), evm: PIN });
    const waiting = await o.next(o.anchoring, { name: "Valid, later in chain order" });
    const r = await verifyOriginal({
      authors: [o.alice.evidence(older)], now: NOW, bytes: (d) => describedBytes(d),
      evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, blocking), rec(2, waiting)]))] },
    });
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "waiting-for-earlier-unverifiable" }));
    expect(r.notices).toContain("publications-waiting");
    expect(r.retain.evmCheckpoints ?? []).toEqual([]);
    // Once nothing waits, a checkpoint is made.
    const fresh = await verifyOriginal({
      authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d),
      evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, blocking), rec(2, waiting)]))] },
    });
    expect(fresh.head).toBe(blocking.versionId);
    expect(fresh.retain.evmCheckpoints).toEqual([expect.objectContaining({ head: blocking.versionId, record: 1 })]);
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.19, P9.23 not anchored", () => {
  test("C12-331: 'Signed anchoring entry not published, genesis `anchor` member alone, or token minted with no publication': not anchored", async () => {
    const o = await original(OPERATOR, 105);
    const cases: Array<[LogEntry[], EvmProviderRead[]]> = [
      [o.log, two(OPERATOR, [], { owner: HOLDER })], // the anchoring entry signed, the token minted, nothing published
      [o.log, two(OPERATOR, [], { owner: null })], // the anchoring entry signed, no token
      [[o.genesis], two(OPERATOR, [], { owner: null })], // only the genesis anchor member
    ];
    for (const [log, reads] of cases) {
      const r = await verify(o.alice, [token(o.alias, reads)], log);
      expect(r.evm?.status).toBe("not-anchored");
      expect(r.evm?.owner).toBeNull();
      expect(r.reasons).toContain("anchor-not-found-on-evm");
      expect(r.ordering).toBe("claimed");
      expect(r.current).toBe(false);
    }
  });

  test("C12-324: 'Token minted by anyone, with a `tokenURI` but no verified history': not shown to be an Original", async () => {
    const o = await original(OPERATOR, 106);
    const junk: EvmRecord = { index: 0, timestamp: TS0, metadataLength: 3, bodyLength: 1, bodyOf: 0, mediaType: "text/plain", metadata: Uint8Array.of(0x83, 1, 2), body: Uint8Array.of(0x41) };
    const tokens = [token(o.alias, two(OPERATOR, [junk], { owner: CAROL }))];
    const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(res).toMatchObject({ status: "not-found", original: null, state: null, document: null });
    const r = await verifyOriginal({ authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm?.owner).toBeNull();
    expect(r.current).toBe(false);
  });

  test("P9.22, P9.25: with no copy, a token no usable provider read is missing evidence, never not anchored", async () => {
    const o = await original(OPERATOR, 107);
    const unread = two(OPERATOR, [], { owner: HOLDER }).map((r) => ({ ...r, records: null, stateUnavailable: true }));
    const r = await verifyOriginal({ authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, unread)] } });
    expect(r.evm?.status).toBe("unverified");
    expect(r.reasons).toContain("evm-evidence-missing");
    expect(r.current).toBe(false);
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.29 moves", () => {
  test("C12-313: 'Verifier that retained the anchor on the token left, then reads a verified move': a move with its source and destination; not a conflicting anchor or a change of anchor", async () => {
    const m = await moving(CONSENSUS, 107);
    const before = await verify(m.alice, [token(m.alias, two(OPERATOR, [rec(0, m.log)]))]);
    expect(before.retain.anchor?.sat).toBe(m.alias);
    const retained = { original: before.retain.original!, authors: before.retain.authors, anchor: before.retain.anchor! };
    const r = await verifyOriginal({
      authors: [m.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), retained,
      evm: { pin: PIN, tokens: [
        token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)], { finalized: 1100 })),
        token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
      ], retained: before.retain.evm },
    });
    expect(r.evm).toMatchObject({ status: "anchored", move: "confirmed", arrival: "arrived", warnings: [] });
    expect(r.evm!.stretches.map((s) => [s.token, s.change, s.conflicting.length])).toEqual([[m.alias, null, 0], [m.dest, null, 0]]);
    expect(r.evm!.stretches[0].departure).toMatchObject({ destination: m.dest });
    expect(r.evm!.stretches[1]).toMatchObject({ arrival: true, anchor: { versionId: m.move.versionId } });
    expect(r.reasons).not.toContain("anchor-changed");
    expect(r.reasons).not.toContain("authoritative-source-changed");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-314: 'Entries from before the first anchoring entry, in a report for a moved Original': carried, with claimed ordering", async () => {
    const o = await original(OPERATOR, 108);
    const dest = derivedTokenAlias(o.id, { chain: CONSENSUS, minter: C }, PIN);
    const toEth = await o.next(o.anchoring, { anchor: { chain: CONSENSUS, minter: C }, aliases: [dest] });
    const toBtc = await o.next(toEth, { anchor: null, aliases: [SAT] });
    const throughEth = [...o.log, toEth];
    const all = [...throughEth, toBtc];
    const r = await verify(o.alice, [
      token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, toEth)])),
      token(dest, two(CONSENSUS, [rec(0, throughEth, TS0 + 600), rec(1, toBtc, TS0 + 612)], { owner: CAROL })),
    ], undefined, {
      bitcoin: [satRead([{ id: "cd".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(all) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(r.evm).toMatchObject({ status: "moved-to-bitcoin", move: "confirmed" });
    expect(r.evm!.carried).toEqual({ entries: [o.genesis.versionId, o.v2.versionId], ordering: "claimed" });
    expect(r.evm!.stretches.map((s) => s.ordering)).toEqual(["attested-by-operator", "proven"]);
    const atV2 = await verify(o.alice, [
      token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, toEth)])),
      token(dest, two(CONSENSUS, [rec(0, throughEth, TS0 + 600), rec(1, toBtc, TS0 + 612)], { owner: CAROL })),
    ], undefined, {
      checkpoint: o.v2.versionId,
      bitcoin: [satRead([{ id: "cd".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(all) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(atV2.ordering).toBe("claimed");
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.28 provisional layers", () => {
  test("C12-330: 'Move entry prepared before any departure record exists': layers judged provisionally by the current classes; by the classes at the departure record's timestamp once it is read", async () => {
    // Base was exit-protected until 20 October 2026 and is operator from then (a later revision).
    const revised: EvmAnchorPin = {
      ...PIN,
      chains: PIN.chains!.map((c) => (c.chain !== BASE ? c : { ...c, classes: [{ from: Date.UTC(2026, 0, 1), class: "exit-protected" as const }, { from: Date.UTC(2026, 9, 20), class: "operator" as const }] })),
    };
    const o = await original(OPERATOR, 109);
    const dest = derivedTokenAlias(o.id, { chain: BASE, minter: C }, revised);
    // Prepared now, with no departure record: Base is judged by its current class, operator, so the move is not upward.
    await expect(updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: BASE, minter: C }, aliases: [dest], evm: revised }))
      .rejects.toMatchObject({ code: "STATE_MOVE_LAYER" });
    // The same move, published while Base was exit-protected: once the departure record is read, its timestamp decides (C12-275).
    const m = await moving(BASE, 110);
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(BASE, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { pin: revised });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.evm!.stretches[0].classAtDeparture).toBe("operator");
  });
});

describe("originals-spec PR 59 a3ffdc1: P14.20 records, P14.21 per-chain address", () => {
  test("C12-311: 'Record that refers to an earlier body': its `bodyLength` is the referred body's length; only its metadata counts toward the 350,000-byte limit", async () => {
    const o = await original(OPERATOR, 111);
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const r0 = rec(0, o.log);
    // A referring record whose bodyLength is not the referred body's: no publication the pinned contract records.
    const zero = { ...sameBody(1, e4, r0), bodyLength: 0 };
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, [r0, zero]))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual({ index: 1, reason: "invalid-body-reference" });
    // 349,999 bytes of metadata referring to a 300,000-byte body is within the limit: decided by its bytes, which were not read here.
    const big: EvmRecord = { index: 1, timestamp: TS0 + 12, metadataLength: 349_999, bodyLength: 300_000, bodyOf: 0, mediaType: r0.mediaType };
    const bigRef = { ...r0, bodyLength: 300_000 };
    const within = await verify(o.alice, [token(o.alias, two(OPERATOR, [bigRef, big]))], o.log);
    expect(within.evm!.stretches[0].ignored.find((x) => x.index === 1)?.reason).not.toBe("too-large");
    missingEvidence(within);
  });

  test("P14.18, P14.21 (a3ffdc1): a chain with its own pinned address: the token alias, the read and did:evm use that chain's address; the code hash stays common", async () => {
    const own = "0x" + "ef".repeat(20);
    const perChain: EvmAnchorPin = { ...PIN, addresses: { [OPERATOR]: own } };
    const key = seeded(112);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const author = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: at(), name: "Elsewhere", resource: photo("per-chain"), author, sign, anchor: { chain: OPERATOR, minter: A }, evm: perChain });
    const id = (genesis.state as { id: string }).id;
    const alias = derivedTokenAlias(id, { chain: OPERATOR, minter: A }, perChain);
    expect(parseEvmAlias(alias).contract).toBe(own);
    expect(derivedTokenAlias(id, { chain: CONSENSUS, minter: A }, perChain)).toContain(PIN.address);
    const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [alias], evm: perChain });
    // The common address on that chain is not the token P14.19 derives under this pin.
    const common = derivedTokenAlias(id, { chain: OPERATOR, minter: A }, PIN);
    await expect(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [common], evm: perChain })).rejects.toMatchObject({ code: "STATE_ANCHOR_TOKEN" });
    const tokens = [token(alias, two(OPERATOR, [rec(0, [genesis, anchoring])]))];
    const r = await verifyOriginal({ authors: [alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: perChain, tokens } });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0].token).toBe(alias);
    const res = await resolveDidEvm(alias, { authors: [alice.evidence()], now: NOW, evm: { pin: perChain, tokens } });
    expect(res.status).toBe("resolved");
    expect((await resolveDidEvm(common, { authors: [alice.evidence()], now: NOW, evm: { pin: perChain, tokens } })).status).toBe("not-found");
  });
});

describe("originals-spec PR 59 a3ffdc1: P3.9 did:evm candidate", () => {
  test("C12-323: 'did:evm DID resolved from token reads alone, the token's first record being junk or another Original's log': candidate from an anchoring or arrival publication, verified with its link to the queried token; the junk record does not decide", async () => {
    const o = await original(OPERATOR, 113);
    const other = await original(OPERATOR, 114);
    const junk: EvmRecord = { index: 0, timestamp: TS0, metadataLength: 3, bodyLength: 1, bodyOf: 0, mediaType: "text/plain", metadata: Uint8Array.of(0x83, 1, 2), body: Uint8Array.of(0x41) };
    for (const first of [junk, rec(0, other.log)]) {
      const records = [first, rec(1, o.log)];
      const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence(), other.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, records))] } });
      expect(res.status, JSON.stringify(res.report?.reasons)).toBe("resolved");
      expect(res.original).toBe(o.id);
      expect(res.report?.evm?.stretches[0].anchor).toMatchObject({ index: 1, versionId: o.anchoring.versionId });
    }
    // Arrival: on a token reached by a move, the arrival publication names the candidate.
    const m = await moving(CONSENSUS, 115);
    const tokens = [
      token(m.alias, two(OPERATOR, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(CONSENSUS, [rec(0, other.log, TS0 + 500), rec(1, m.through, TS0 + 600)], { owner: CAROL })),
    ];
    const here = await resolveDidEvm(m.dest, { authors: [m.alice.evidence(), other.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(here).toMatchObject({ status: "resolved", original: m.id });
  });
});

describe("originals-spec PR 59: tokenURI and carried files from publications", () => {
  test("C12-286: 'Document returned by the token's tokenURI, offered as the did:evm DID document': not used (P3.9, P3.8)", async () => {
    const o = await original(OPERATOR, 91);
    const forged = {
      "@context": ["https://www.w3.org/ns/did/v1"], id: o.alias, alsoKnownAs: ["did:vh:QmForgedForgedForgedForgedForgedForgedForged1"],
      service: [{ id: `${o.alias}#files`, type: "OriginalsFiles", serviceEndpoint: "https://evil.example/files/" }],
      verificationMethod: [{ id: `${o.alias}#k`, type: "Multikey", controller: o.alias, publicKeyMultibase: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }],
    };
    const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify(forged))}`;
    const withUri = (reads: EvmProviderRead[]) => reads.map((r) => ({ ...r, tokenURI, document: forged }) as EvmProviderRead);
    const base = { authors: [o.alice.evidence()], now: NOW };
    // Offered beside an accepted log: the derived document, never the offered one.
    const plain = await resolveDidEvm(o.alias, { ...base, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)]))] } });
    const offered = await resolveDidEvm(o.alias, { ...base, document: forged, tokenURI, evm: { pin: PIN, tokens: [token(o.alias, withUri(two(OPERATOR, [rec(0, o.log)])))] } } as never);
    expect(offered.status).toBe("resolved");
    expect(canonicalize(offered.document as JsonValue)).toBe(canonicalize(plain.document as JsonValue));
    expect(offered.document).toMatchObject({ id: o.alias, alsoKnownAs: [o.id] });
    expect(JSON.stringify(offered.document)).not.toContain("evil.example");
    expect(offered.original).toBe(o.id);
    // Offered for a token with no accepted anchoring publication: it resolves to nothing, whatever tokenURI says.
    const minted = await resolveDidEvm(o.alias, { ...base, document: forged, tokenURI, evm: { pin: PIN, tokens: [token(o.alias, withUri(two(OPERATOR, [])))] } } as never);
    expect(minted).toMatchObject({ status: "not-found", document: null, state: null, original: null });
  });

  test("C12-291: 'Writer making a carried file from an accepted publication's body and entries': allowed for an EVM publication, as for any accepted checkpoint (P7.16, P7.15)", async () => {
    const o = await original(OPERATOR, 92);
    const v3 = await o.next(o.anchoring, { resource: photo("dusk v3 92") });
    const records = [rec(0, o.log), rec(1, v3)];
    const r = await verify(o.alice, [token(o.alias, two(OPERATOR, records))]);
    expect(r.evm!.stretches[0].accepted.map((p) => p.index)).toEqual([1]);
    expect(r.head).toBe(v3.versionId);
    // The two parts of a carried file: the entries of the accepted publications, in index order, and the last one's body.
    const entries = records.flatMap((x) => {
      const read = readInscribedEntries(x.metadata);
      if (read.kind !== "entries") throw new Error(`record ${x.index} carries no entries`);
      return read.entries;
    });
    expect(entries.map((e) => e.versionId)).toEqual([...o.log, v3].map((e) => e.versionId));
    const body = records[1].body!;
    const file = await writeCarriedFile(body, entries, { disclosed: carriedDisclosure(entries) });
    const read = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, records))] } });
    expect(read.verified, JSON.stringify(read.reasons)).toEqual({ log: true, version: true });
    expect(read.anchoring.status).toBe("evm");
    expect(read.current).toBe(true);
    // The carrier is never part of what is published: removing it gives the body back (P7.16).
    expect(file.length).toBeGreaterThan(body.length);
    expect(file.slice(0, body.length)).toEqual(body);
  });
});

describe("the writer's own committed log, before publishing (P9.18; owner decision, 13 November 2026)", () => {
  test("C12-28, C12-332: 'Writer checking its committed log before publishing an entry, the entry not yet on the chain': with `localCopy` and no token read, verified whole as a local copy, unverified on the chain and never current", async () => {
    const o = await original(OPERATOR, 140);
    const later = await o.next(o.anchoring, { name: "Harbor, later" });
    const log = [...o.log, later];
    const r = await verifyOriginal({ log, authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: PIN, tokens: [], localCopy: true } });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.history.entries).toBe(4);
    expect(r.head).toBe(later.versionId);
    missingEvidence(r);
    expect(r.ordering).toBe("claimed");
    expect(r.evm?.owner).toBeNull();
    // P9.18: the result says it is a local copy, so it is never mistaken for a reader's result.
    expect(r.evm).toMatchObject({ localCopy: true, status: "unverified" });
    expect(r.reasons).toContain("local-copy");
    // Without the opt-in, as for a carried log or a package (P7.14): at most the entries before the anchoring entry.
    const copy = await verify(o.alice, [], log);
    expect(copy.history.entries).toBe(2);
    expect(copy.head).toBe(o.v2.versionId);
    expect(copy.evm?.localCopy).toBe(false);
  });

  test("C12-333: 'Local-copy result placed in a report given to a reader, or presented as anchored or current': never; whatever the token read shows, a result with one is no local copy", async () => {
    const o = await original(OPERATOR, 143);
    const later = await o.next(o.anchoring, { name: "Harbor, later" });
    for (const tokens of [[], [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], [token(o.alias, two(OPERATOR, [rec(0, o.log), rec(1, later)]))]]) {
      const r = await verifyOriginal({ log: [...o.log, later], authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: PIN, tokens, localCopy: true } });
      if (r.evm!.localCopy) {
        expect(r.evm!.status).toBe("unverified");
        expect(r.current).toBe(false);
        expect(r.ordering).toBe("claimed");
        expect(r.reasons).toContain("local-copy");
      } else {
        expect(r.evm!.status).toBe("anchored");
        expect(r.reasons).not.toContain("local-copy");
      }
    }
  });

  test("P7.14: a token read decides even with `localCopy`: the local log is never preferred to the anchor", async () => {
    const o = await original(OPERATOR, 141);
    const later = await o.next(o.anchoring, { name: "Harbor, later" });
    const r = await verifyOriginal({ log: [...o.log, later], authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: PIN, tokens: [token(o.alias, two(OPERATOR, [rec(0, o.log)]))], localCopy: true } });
    expect(r.evm?.status).toBe("anchored");
    expect(r.head).toBe(o.anchoring.versionId);
  });

  test("`localCopy` without a pin is still unsupported, never verified (section 14, P14.21)", async () => {
    const o = await original(OPERATOR, 142);
    const r = await verifyOriginal({ log: o.log, authors: [o.alice.evidence()], now: NOW, evm: { pin: null, tokens: [], localCopy: true } });
    expect(r.evm?.status).toBe("unsupported");
    expect(r.validAsOf).toBeNull();
  });
});

describe("P9.22 usable providers (originals-spec PR 59 1b5c484; owner decision, 13 November 2026)", () => {
  test("C12-334: 'One provider configured, passing P9.21's checks and serving the contract's state at the finalized block': verified on its read; the report names it and marks the read uncorroborated", async () => {
    const o = await original(OPERATOR, 120);
    const r = await verify(o.alice, [token(o.alias, [read(OPERATOR, [rec(0, o.log)], { provider: "only" })])]);
    expect(r.history.status).toBe("valid");
    expect(r.evm?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0]).toMatchObject({ providers: ["only"], uncorroborated: true, excludedProviders: [], block: { number: 1000 } });
    expect(r.evm!.owner).toMatchObject({ providers: ["only"], uncorroborated: true });
  });

  test("C12-335: 'Two providers configured, one reporting another chain ID or block 0 hash, or unable to serve state at the finalized block': that provider dropped, its answers not evidence; the other's read stands, named and marked uncorroborated", async () => {
    const o = await original(OPERATOR, 121);
    const good = read(OPERATOR, [rec(0, o.log)], { provider: "rpc-a" });
    // Each failing provider would otherwise disagree with the good one: its answers are not evidence.
    const lying = [rec(0, o.genesis)];
    const cases: Array<[EvmProviderRead, string]> = [
      [read(OPERATOR, lying, { provider: "rpc-b", chainId: 1n }), "wrong-chain-id"],
      [read(OPERATOR, lying, { provider: "rpc-b", genesisHash: "0x" + "ee".repeat(32) }), "wrong-genesis-hash"],
      // Its finalized block is the lower one, but it cannot serve state there: dropped, and not the common block.
      [{ ...read(OPERATOR, null, { provider: "rpc-b", finalized: 990, codeHash: null, owner: null }), stateUnavailable: true }, "state-unavailable"],
      // Records it could not read from state at the block, the code being the pinned code.
      [read(OPERATOR, null, { provider: "rpc-b" }), "state-unavailable"],
    ];
    for (const [bad, reason] of cases) {
      for (const reads of [[good, bad], [bad, good]]) {
        const r = await verify(o.alice, [token(o.alias, reads)], o.log);
        expect(r.evm?.status, reason).toBe("anchored");
        expect(r.head).toBe(o.anchoring.versionId);
        expect(r.evm!.stretches[0]).toMatchObject({ providers: ["rpc-a"], uncorroborated: true, excludedProviders: [{ provider: "rpc-b", reason }], block: { number: 1000 } });
        expect(r.evm!.owner).toMatchObject({ address: HOLDER, providers: ["rpc-a"], uncorroborated: true });
        expect(r.current, JSON.stringify(r.reasons)).toBe(true);
      }
    }
  });

  test("C12-336: 'Every configured provider fails P9.21's checks or cannot serve state at the finalized block': missing evidence", async () => {
    const o = await original(OPERATOR, 122);
    const unavailable = (provider: string): EvmProviderRead => ({ ...read(OPERATOR, null, { provider, codeHash: null, owner: null }), stateUnavailable: true });
    const cases: Array<[EvmProviderRead[], string]> = [
      [[unavailable("rpc-a"), unavailable("rpc-b")], "EVM_STATE_UNAVAILABLE"],
      [[read(OPERATOR, [rec(0, o.log)], { provider: "rpc-a", chainId: 1n }), unavailable("rpc-b")], "EVM_STATE_UNAVAILABLE"],
      [[read(OPERATOR, [rec(0, o.log)], { provider: "rpc-a", chainId: 1n }), read(OPERATOR, [rec(0, o.log)], { provider: "rpc-b", genesisHash: "0x" + "ee".repeat(32) })], "EVM_NO_PROVIDER"],
      [[read(OPERATOR, null, { provider: "rpc-a" })], "EVM_RECORDS_UNREADABLE"],
    ];
    for (const [reads, code] of cases) {
      const r = await verify(o.alice, [token(o.alias, reads)], o.log);
      missingEvidence(r);
      expect(r.evm!.stretches[0].missing?.code).toBe(code);
      expect(r.evm!.stretches[0].providers).toEqual([]);
      expect(r.evm!.owner).toBeNull();
      expect(r.history.entries).toBe(2);
    }
  });
});

describe("P9.24 after a finality failure (originals-spec PR 59 1b5c484)", () => {
  test("C12-337: 'Anchor on a chain of any trust class, after a finality failure on that chain': uniqueness not established, never established or attested", async () => {
    const seeds: Record<string, number> = { [OPERATOR]: 130, [CONSORTIUM]: 131, [CONSENSUS]: 132, [BASE]: 133 };
    for (const chain of [OPERATOR, CONSORTIUM, CONSENSUS, BASE]) {
      const o = await original(chain, seeds[chain]);
      const retained = [{ chain, number: 1000, hash: blockHash(chain, 1000) }];
      const held = await verify(o.alice, [token(o.alias, two(chain, [rec(0, o.log)]))], undefined, { retained });
      expect(held.evm!.stretches[0].uniqueness.status, chain).not.toBe("not-established");
      const failed = await verify(o.alice, [token(o.alias, two(chain, [rec(0, o.log)], { finalized: 1200, blockHashes: [{ number: 1000, hash: blockHash(chain, 1000, 4) }] }))], undefined, { retained });
      expect(failed.evm!.stretches[0].finality, chain).toBe("failed");
      expect(failed.evm!.stretches[0].uniqueness, chain).toEqual({ status: "not-established" });
      expect(failed.current).toBe(false);
    }
  });
});

describe("P9.29 after an unconfirmed move (originals-spec PR 59 1b5c484)", () => {
  test("C12-338: 'Moved Original with publications after the arrival, a chain it left cannot be read': those entries verified as part of the log and reported as following an unconfirmed move; none current", async () => {
    const m = await moving(CONSENSUS, 134);
    const after = await m.next(m.move, { name: "Published after the arrival" });
    const r = await verify(m.alice, [
      token(m.alias, two(OPERATOR, null)),
      token(m.dest, two(CONSENSUS, [rec(0, m.through, TS0 + 600), rec(1, after, TS0 + 700)], { owner: CAROL })),
    ], [...m.through, after]);
    expect(r.history).toMatchObject({ status: "valid", entries: 5 });
    expect(r.head).toBe(after.versionId);
    expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null });
    expect(r.evm!.stretches[1]).toMatchObject({ chain: CONSENSUS, arrival: true, entries: [after.versionId] });
    expect(r.evm!.stretches[1].accepted.map((p) => p.versionId)).toEqual([after.versionId]);
    expect(r.reasons).toContain("move-unconfirmed");
    expect(r.current).toBe(false);
    expect(r.validAsOf?.checkpoint).toBe(after.versionId);
  });
});
