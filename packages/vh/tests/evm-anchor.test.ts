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
  resolveDidEvm,
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
} from "../src/originals/index.js";
import { VhAuthor, bytes, carrying, clock, describedBytes, photo, seeded } from "./helpers/originals.js";

const PIN: EvmAnchorPin = { address: "0x" + "ab".repeat(20), codeHash: "0x" + "c0".repeat(32) };
const ROBINHOOD = "eip155:4663"; // operator: attested
const TEMPO = "eip155:4217"; // consortium: attested
const ETHEREUM = "eip155:1"; // consensus: proven
const BASE = "eip155:8453"; // exit-protected: proven
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
async function original(chain = ROBINHOOD, seed = 41) {
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
  test("C12-279: 'Report for an Original anchored on an EVM chain': names the chain, its class, the token, the finalized block and the providers; never a Bitcoin anchor", async () => {
    const o = await original();
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))]);
    expect(r.history.status).toBe("valid");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.anchoring).toBeNull();
    expect(r.ownership).toBeNull();
    expect(r.ordering).toBe("evm-attested-by-operator");
    const s = r.evm!.stretches[0];
    expect(s).toMatchObject({ chain: ROBINHOOD, name: "Robinhood Chain", class: "operator", layer: "attested", token: o.alias, block: { number: 1000, hash: blockHash(ROBINHOOD, 1000) }, providers: ["rpc-a", "rpc-b"] });
    expect(s.caip19).toBe(`${ROBINHOOD}/erc721:${PIN.address}/${parseEvmAlias(o.alias).tokenId}`);
    expect(r.evm!.owner).toMatchObject({ address: HOLDER, chain: ROBINHOOD, class: "operator", describes: "attested-by-operator", token: o.alias, block: { number: 1000 } });
    expect(s.entries).toEqual([o.anchoring.versionId]);
    expect(s.carried).toEqual([o.genesis.versionId, o.v2.versionId]);
    // The body of the anchoring publication is the current version, read from the chain (P9.25).
    expect(r.resources.versions[1]).toMatchObject({ bytes: "verified", onBitcoin: false, onEvm: ROBINHOOD });
    expect(r.retain.evm).toEqual([{ chain: ROBINHOOD, number: 1000, hash: blockHash(ROBINHOOD, 1000) }]);
  });

  test("C12-280: 'Report for an Original anchored on a consortium or operator chain': attested by its validators or operator, never proven", async () => {
    const tempo = await original(TEMPO, 42);
    const r = await verify(tempo.alice, [token(tempo.alias, two(TEMPO, [rec(0, tempo.log)]))]);
    expect(r.ordering).toBe("evm-attested-by-validators");
    // P9.24 as changed at a3ffdc1: uniqueness in the terms of the class.
    expect(r.evm!.stretches[0].uniqueness).toMatchObject({ status: "attested-by-validators", class: "consortium", chain: TEMPO });
    expect(r.evm!.owner?.describes).toBe("attested-by-validators");
    const eth = await original(ETHEREUM, 43);
    const p = await verify(eth.alice, [token(eth.alias, two(ETHEREUM, [rec(0, eth.log)]))]);
    expect(p.ordering).toBe("evm-proven");
    expect(p.evm!.owner?.describes).toBe("proven");
    expect(p.evm!.stretches[0].uniqueness).toMatchObject({ status: "established", class: "consensus" });
  });
});

describe("support: section 14, P9.19, P9.21", () => {
  test("C12-239: 'Genesis entry with an anchor member while P14.21 pins no contract': unsupported, not invalid; nothing verified", async () => {
    const o = await original();
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))], o.log, { pin: null });
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
    // A revision of P14.22 without Robinhood Chain: unsupported, not invalid (P9.19).
    const without: EvmAnchorPin = { ...PIN, chains: EVM_CHAINS.filter((c) => c.chain !== ROBINHOOD) };
    const r = await verify(o.alice, [], o.log, { pin: without });
    expect(r.history.status).toBe("unsupported");
    expect(r.history.failure?.code).toBe("EVM_CHAIN_NOT_LISTED");
    expect(r.validAsOf).toBeNull();
  });

  test("C12-242: 'The pinned contract deployed on a chain that is not listed': unsupported", async () => {
    const optimism: ListedChain = { name: "OP Mainnet", chain: "eip155:10", chainId: 10n, genesisHash: "0x" + "7a".repeat(32), classes: [{ from: 0, class: "exit-protected" }] };
    const devnet: EvmAnchorPin = { ...PIN, chains: [...EVM_CHAINS, optimism] };
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
      const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)], { codeHash }))], o.log);
      expect(r.history.status).toBe("unsupported");
      expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_ANCHOR_CODE_MISMATCH" } });
      expect(r.reasons).not.toContain("anchor-not-found-on-evm");
      expect(r.current).toBe(false);
    }
  });

  test("C12-240: 'Provider reporting the listed chain ID whose block 0 has another hash': not that chain; its answers are not evidence", async () => {
    const o = await original();
    const impostor = read(ROBINHOOD, [rec(0, o.log)], { provider: "rpc-fake", genesisHash: "0x" + "99".repeat(32), owner: CAROL });
    // With an honest provider beside it, the impostor is excluded, not a disagreement.
    const r = await verify(o.alice, [token(o.alias, [read(ROBINHOOD, [rec(0, o.log)]), impostor])]);
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
    // The token's alias, but read from Ethereum, where the same contract may also be deployed (P9.20).
    const r = await verify(o.alice, [token(o.alias, two(ETHEREUM, [rec(0, o.log)]), ETHEREUM)], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].excludedProviders.map((x) => x.reason)).toEqual(["other-chain", "other-chain"]);
    expect(r.history.entries).toBe(2); // only what precedes the anchoring entry (P7.14)
  });
});

describe("P9.22 finality and providers", () => {
  test("C12-244: 'Publication record present at the latest block but not in state at the finalized block': observed, not accepted; pending", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Harbor at dusk, cropped" });
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)], { observed: [rec(1, e4)] }))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].observed).toEqual([{ index: 1, timestamp: TS0 + 12 }]);
    expect(r.evm!.stretches[0].ignored).toContainEqual({ index: 1, reason: "observed-not-finalized" });
    expect(r.current).toBe(true); // the finalized state is current as of its block
  });

  test("C12-245: 'Two providers report different hashes for the lower of their finalized blocks, or a different record, bytes or ownerOf': missing evidence until they agree", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const ok = [rec(0, o.log), rec(1, e4)];
    const cases: EvmProviderRead[][] = [
      [read(ROBINHOOD, ok), read(ROBINHOOD, ok, { provider: "rpc-b", block: { number: 1000, hash: blockHash(ROBINHOOD, 1000, 1) } })],
      [read(ROBINHOOD, ok), read(ROBINHOOD, [rec(0, o.log)], { provider: "rpc-b" })],
      [read(ROBINHOOD, ok), read(ROBINHOOD, [rec(0, o.log), { ...rec(1, e4), body: bytes("other bytes") }], { provider: "rpc-b" })],
      [read(ROBINHOOD, ok), read(ROBINHOOD, ok, { provider: "rpc-b", owner: CAROL })],
    ];
    for (const reads of cases) {
      const r = await verify(o.alice, [token(o.alias, reads)], o.log);
      missingEvidence(r);
      expect(r.evm!.stretches[0].missing?.code).toBe("EVM_PROVIDERS_DISAGREE");
      expect(r.evm!.owner).toBeNull();
      expect(r.history.entries).toBe(2);
    }
  });

  test("C12-246: 'One provider's finalized block is N and the other's is N+1, and they agree on block N': verified at block N", async () => {
    const o = await original();
    const at1000 = { number: 1000, hash: blockHash(ROBINHOOD, 1000) };
    const r = await verify(o.alice, [token(o.alias, [read(ROBINHOOD, [rec(0, o.log)], { finalized: 1000 }), read(ROBINHOOD, [rec(0, o.log)], { provider: "rpc-b", finalized: 1001, block: at1000 })])]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.evm!.stretches[0].block).toEqual(at1000);
    // A reader that read the ahead provider at its own finalized block did not read block N from both.
    const unread = await verify(o.alice, [token(o.alias, [read(ROBINHOOD, [rec(0, o.log)], { finalized: 1000 }), read(ROBINHOOD, [rec(0, o.log)], { provider: "rpc-b", finalized: 1001 })])], o.log);
    missingEvidence(unread);
  });

  test("C12-247: 'A block accepted as finalized is replaced': authoritative-source-changed and a finality failure", async () => {
    const o = await original();
    const tokens = [token(o.alias, two(ROBINHOOD, [rec(0, o.log)], { finalized: 1200, blockHashes: [{ number: 1000, hash: blockHash(ROBINHOOD, 1000, 5) }] }))];
    const r = await verify(o.alice, tokens, undefined, { retained: [{ chain: ROBINHOOD, number: 1000, hash: blockHash(ROBINHOOD, 1000) }] });
    expect(r.evm!.stretches[0].finality).toBe("failed");
    expect(r.evm!.warnings).toEqual(["authoritative-source-changed"]);
    expect(r.reasons).toEqual(expect.arrayContaining(["authoritative-source-changed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
    expect(r.evm!.owner).toBeNull();
    // The same block, unreplaced, holds.
    const held = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))], undefined, { retained: [{ chain: ROBINHOOD, number: 1000, hash: blockHash(ROBINHOOD, 1000) }] });
    expect(held.evm!.stretches[0].finality).toBe("held");
    expect(held.current).toBe(true);
  });
});

describe("P9.23, P9.24 ownership and the anchor", () => {
  test("C12-248: 'Token minted, no anchoring publication': not anchored; no owner", async () => {
    const o = await original();
    for (const records of [[], [rec(0, [o.genesis, o.v2])]]) {
      const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, records))], o.log);
      expect(r.evm?.status).toBe("not-anchored");
      expect(r.evm?.owner).toBeNull();
      expect(r.reasons).toContain("anchor-not-found-on-evm");
      expect(r.current).toBe(false);
    }
  });

  test("C12-264: 'Token held by a contract account': that contract is the owner", async () => {
    const o = await original();
    const safe = "0x" + "5a".repeat(20); // a multisig contract; ownerOf does not say which
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)], { owner: safe }))]);
    expect(r.evm!.owner?.address).toBe(safe);
  });

  test("C12-249 (changed at a3ffdc1), C12-294: 'Two anchoring entries from different branches published on the token' and 'Fork of an Original with an EVM anchor, then an anchoring entry accepted': the lower index is the anchor and settles the fork; uniqueness attested by the operator", async () => {
    const o = await original();
    const v2b = await o.next(o.genesis, { name: "Harbor at night" });
    const anchoringB = await o.next(v2b, { aliases: [o.alias] });
    const branchB = [o.genesis, v2b, anchoringB];
    // The supplied copy and a second copy are the two branches of the fork (P6.6).
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, branchB), rec(1, o.log)]))], o.log, { copies: [{ source: "other", log: branchB.map((e) => JSON.stringify(e) + "\n").join("") }] });
    const s = r.evm!.stretches[0];
    expect(s.anchor).toMatchObject({ index: 0, versionId: anchoringB.versionId });
    expect(s.conflicting).toEqual([expect.objectContaining({ index: 1, versionId: o.anchoring.versionId })]);
    expect(r.head).toBe(anchoringB.versionId);
    expect(r.fork).toBeNull();
    expect(s.uniqueness).toEqual({ status: "attested-by-operator", chain: ROBINHOOD, class: "operator", block: { number: 1000, hash: blockHash(ROBINHOOD, 1000) }, providers: ["rpc-a", "rpc-b"] });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-250: 'Two publications extending the same head, recorded in one block or in different blocks': the lower record index is accepted", async () => {
    const o = await original();
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(o.anchoring, { name: "B" });
    for (const tsB of [TS0 + 12, TS0 + 24]) {
      const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, a, TS0 + 12), rec(2, b, tsB)]))]);
      expect(r.head).toBe(a.versionId);
      expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "does-not-extend-head" }));
    }
  });

  test("C12-251: 'Two successive publications, the second extending the first, recorded in one block': both accepted, in index order", async () => {
    const o = await original();
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(a, { name: "B" });
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log, TS0), rec(1, a, TS0), rec(2, b, TS0)]))]);
    expect(r.head).toBe(b.versionId);
    expect(r.evm!.stretches[0].accepted.map((p) => p.index)).toEqual([1, 2]);
    expect(r.current).toBe(true);
  });

  test("C12-251: '…or in two blocks of a rollup that share one parent-chain block number': both accepted, in index order (P9.13, P9.20, P14.20)", async () => {
    // Arbitrum One: its blocks can share a timestamp and a contract sees its parent chain's approximate
    // block number [S42]. A record holds no block number, only its index and timestamp (P14.20), so two
    // rollup blocks behind one parent-chain block are, to the verifier, the index order and nothing else.
    const ARBITRUM = "eip155:42161";
    expect(listed(ARBITRUM)).toBeDefined();
    const o = await original(ARBITRUM, 47);
    const a = await o.next(o.anchoring, { name: "A" });
    const b = await o.next(a, { name: "B" });
    const records = [rec(0, o.log, TS0), rec(1, a, TS0 + 1), rec(2, b, TS0 + 1)];
    for (const r of records) expect(Object.keys(r).some((k) => /block/i.test(k))).toBe(false);
    const r = await verify(o.alice, [token(o.alias, two(ARBITRUM, records))]);
    expect(r.head).toBe(b.versionId);
    expect(r.evm!.stretches[0].accepted.map((p) => [p.index, p.versionId])).toEqual([[1, a.versionId], [2, b.versionId]]);
    expect(r.evm!.stretches[0].ignored).toEqual([]);
    // The second publication extends the first, so index order decides; a later record that does not extend the head is not accepted.
    const stale = await o.next(o.anchoring, { name: "C" });
    const forked = await verify(o.alice, [token(o.alias, two(ARBITRUM, [...records, rec(3, stale, TS0 + 1)]))]);
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
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), huge, longType, sameBodyHuge]))]);
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
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), junk]))]);
    expect(r.evm!.stretches[0].ignored).toEqual([expect.objectContaining({ index: 1, reason: "undecodable" })]);
    expect(r.current).toBe(true);
  });

  test("C12-257: 'Publication whose body digest, size or media type differs from the last entry's descriptor': rejected", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const wrongBody = { ...rec(1, e4), body: bytes("not the photograph"), bodyLength: 18 };
    const wrongType = { ...rec(1, e4), mediaType: "image/png" };
    for (const [bad, reason] of [[wrongBody, "body-not-the-resource"], [wrongType, "content-type-mismatch"]] as const) {
      const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), bad]))]);
      expect(r.head).toBe(o.anchoring.versionId);
      expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason }));
    }
  });

  test("C12-258: 'Publication that refers to an earlier record's body, the last entry not changing the resource': accepted, the body checked as if stored", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const first = rec(0, o.log);
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [first, sameBody(1, e4, first)]))]);
    expect(r.head).toBe(e4.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-259: 'Publication that refers to an earlier record's body whose digest differs from the last entry's descriptor': rejected", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { resource: photo("dusk v3") });
    const first = rec(0, o.log);
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [first, sameBody(1, e4, first)]))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason: "body-not-the-resource" }));
  });

  test("C12-261: 'Publication known only from a Published event, or a token whose records or bytes cannot be read from state': resolution fails with missing evidence", async () => {
    const o = await original();
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    // Records not read (a reader that found the publication only through an event has no record).
    missingEvidence(await verify(o.alice, [token(o.alias, two(ROBINHOOD, null))], o.log));
    // A record whose bytes were not read: never decided on the part that was (P9.25).
    const unread = { ...rec(1, e4), metadata: undefined, body: undefined };
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), unread]))], o.log);
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
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))], o.log);
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 0, reason: "author-key-not-valid-at-inscription-time" }));
    // The record's inscription time is the greatest timestamp so far: an earlier timestamp on a later record does not reach back.
    const p = await original(ROBINHOOD, 50);
    const e4 = await p.next(p.anchoring, { name: "late" });
    p.alice.timeOverride = iso(TS0 + 30);
    await p.alice.rotate([{ fragment: "next", signer: seeded(51) }]);
    // Record 2 holds an earlier timestamp than record 1; its inscription time is record 1's, after the removal.
    const later = await verify(p.alice, [token(p.alias, two(ROBINHOOD, [rec(0, p.log, TS0), rec(1, p.genesis, TS0 + 60), rec(2, e4, TS0 + 20)]))]);
    expect(later.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "author-key-not-valid-at-inscription-time" }));
    expect(later.head).toBe(p.anchoring.versionId);
  });

  test("C12-293: 'Entry published on an Original's token, whose signer later removes the signing key': remains current; not historically authorized only; not claimed", async () => {
    const o = await original();
    o.alice.timeOverride = iso(TS0 + 3600);
    await o.alice.rotate([{ fragment: "next", signer: seeded(52) }]);
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))]);
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
        const genesis = await createOriginal({ versionTime: at(), name: "Harbor", metadata: { pad: "a".repeat(pad) }, resource: photo("limit"), author, sign, anchor: { chain: ROBINHOOD, minter: A }, evm: PIN });
        const size = new TextEncoder().encode(canonicalize(genesis as unknown as JsonValue)).length;
        if (size === target) {
          const id = (genesis.state as { id: string }).id;
          const alias = derivedTokenAlias(id, { chain: ROBINHOOD, minter: A }, PIN);
          const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, metadata: null, aliases: [alias], evm: PIN });
          return { log: [genesis, anchoring], alias, anchoring };
        }
        pad += target - size;
      }
      throw new Error(`no entry of ${target} bytes`);
    };
    const fits = await atSize(65_536);
    const ok = await verify(alice, [token(fits.alias, two(ROBINHOOD, [rec(0, fits.log)]))]);
    expect(ok.evm?.status, JSON.stringify(ok.evm?.stretches[0]?.ignored)).toBe("anchored");
    expect(ok.head).toBe(fits.anchoring.versionId);
    const over = await atSize(65_537);
    const r = await verify(alice, [token(over.alias, two(ROBINHOOD, [rec(0, over.log)]))]);
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm?.stretches[0]?.ignored).toEqual([expect.objectContaining({ index: 0, code: "ENTRY_TOO_LARGE" })]);
    expect(r.current).toBe(false);
  });
});

describe("P7.14 copies of the log", () => {
  test("C12-287: 'Carried file of an Original whose log has an anchor member, the chain readable': state from the token; the copy not preferred; chain and class named", async () => {
    const o = await original();
    const unpublished = await o.next(o.anchoring, { name: "Draft name" });
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))], [...o.log, unpublished]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.state?.name).toBe("Harbor at dusk");
    expect(r.evm!.stretches[0]).toMatchObject({ chain: ROBINHOOD, class: "operator" });
    expect(r.current).toBe(true);
  });

  test("C12-287, C12-234: carried file read through readCarriedFile, the chain readable / not read: verified from the token / evm-unread, missing evidence (P7.14)", async () => {
    const o = await original();
    const d = (o.anchoring.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
    const file = await writeCarriedFile(describedBytes(d)!, o.log, { disclosed: carriedDisclosure(o.log) });
    const read = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))] } });
    expect(read.anchoring.status).toBe("evm");
    expect(read.verified, JSON.stringify(read.reasons)).toEqual({ log: true, version: true });
    expect(read.current).toBe(true);
    expect(read.report?.evm?.stretches[0]).toMatchObject({ chain: ROBINHOOD, class: "operator" });
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
    for (const tokens of [[token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))], []]) {
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

/** An Original anchored on Robinhood Chain, with a move entry to `to` (an EVM chain, or Bitcoin when null). */
async function moving(to: string | null = ETHEREUM, seed = 61) {
  const o = await original(ROBINHOOD, seed);
  const dest = to ? derivedTokenAlias(o.id, { chain: to, minter: C }, PIN) : SAT;
  const move = await o.next(o.anchoring, to ? { anchor: { chain: to, minter: C }, aliases: [dest] } : { anchor: null, aliases: [SAT] });
  const through = [...o.log, move];
  return { ...o, dest, move, through };
}

describe("P9.28, P9.29 moves", () => {
  test("C12-265: 'Move entry from an attested chain to a proven chain or to Bitcoin, departed and arrived': anchored on the destination; the owner is its holder", async () => {
    const m = await moving(ETHEREUM);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ]);
    expect(r.evm).toMatchObject({ status: "anchored", move: "confirmed" });
    expect(r.evm!.owner).toMatchObject({ address: CAROL, chain: ETHEREUM, describes: "proven" });
    expect(r.head).toBe(m.move.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);

    const b = await moving(null, 62);
    const btc = await verify(b.alice, [token(b.alias, two(ROBINHOOD, [rec(0, b.log), rec(1, b.move)]))], undefined, {
      bitcoin: [satRead([{ id: "ab".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(b.through) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(btc.evm).toMatchObject({ status: "moved-to-bitcoin", move: "confirmed", owner: null });
    expect(btc.anchoring).toMatchObject({ status: "anchored", sat: SAT });
    expect(btc.ownership).toMatchObject({ status: "provisional", sat: SAT });
    // The move entry keeps the ordering of the stretch it was accepted on (P9.29).
    expect(btc.ordering).toBe("evm-attested-by-operator");
    expect(btc.current, JSON.stringify(btc.reasons)).toBe(true);
  });

  test("C12-276: 'Report for an Original that moved from an attested chain to a proven chain': both chains, their classes and entries; the earlier stretch attested", async () => {
    const m = await moving(ETHEREUM, 63);
    const e5 = await m.next(m.move, { name: "On Ethereum" });
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600), rec(1, e5, TS0 + 612)], { owner: CAROL })),
    ]);
    const [left, here] = r.evm!.stretches;
    expect(left).toMatchObject({ chain: ROBINHOOD, class: "operator", describes: "attested-by-operator", entries: [m.anchoring.versionId, m.move.versionId], providers: ["rpc-a", "rpc-b"], block: { number: 1000 } });
    expect(left.departure).toMatchObject({ index: 1, versionId: m.move.versionId, destination: m.dest });
    expect(here).toMatchObject({ chain: ETHEREUM, class: "consensus", describes: "proven", arrival: true, entries: [e5.versionId], carried: m.through.map((e) => e.versionId) });
    expect(r.ordering).toBe("evm-proven");
    expect(r.current).toBe(true);
  });

  test("C12-269: 'Arrival on the destination with no departure accepted on the chain left': not accepted; still anchored where it was", async () => {
    const m = await moving(ETHEREUM, 64);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: A })),
    ]);
    expect(r.evm!.stretches.map((s) => s.chain)).toEqual([ROBINHOOD]);
    expect(r.head).toBe(m.anchoring.versionId);
    expect(r.evm!.owner?.address).toBe(HOLDER);
  });

  test("C12-270: 'Departure accepted, no arrival yet': departed, not arrived; the move entry's state; no owner", async () => {
    const m = await moving(ETHEREUM, 65);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(ETHEREUM, [], { owner: null })),
    ]);
    expect(r.evm).toMatchObject({ status: "departed-not-arrived", destination: m.dest, owner: null });
    expect(r.head).toBe(m.move.versionId);
    expect(r.state?.anchor).toEqual({ chain: ETHEREUM, minter: C });
    expect(r.reasons).toContain("departed-not-arrived");
    expect(r.current).toBe(false);
  });

  test("C12-271: 'Publication on the token left behind, after the departure': not accepted; reported", async () => {
    const m = await moving(ETHEREUM, 66);
    const stray = await m.next(m.move, { name: "Published on the old token" });
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move), rec(2, stray)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ]);
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 2, reason: "after-departure" }));
    expect(r.head).toBe(m.move.versionId);
  });

  test("C12-272: 'Arrival whose log differs from the entries accepted through the departure, or whose last entry is not the move entry': not an arrival", async () => {
    const m = await moving(ETHEREUM, 67);
    const other = await m.next(m.anchoring, { anchor: { chain: ETHEREUM, minter: C }, aliases: [m.dest], name: "Another move entry" });
    for (const carried of [[...m.log, other], m.log]) {
      const r = await verify(m.alice, [
        token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
        token(m.dest, two(ETHEREUM, [rec(0, carried, TS0 + 600)], { owner: CAROL })),
      ]);
      expect(r.evm?.status).toBe("departed-not-arrived");
      expect(r.evm!.stretches[1].ignored).toContainEqual(expect.objectContaining({ index: 0, reason: "not-an-arrival" }));
    }
  });

  test("C12-273 (changed at a3ffdc1), C12-315: 'Carried log holding a move entry, the current chain read and a chain it left unreadable': proofs and hash links verified from genesis; move unconfirmed; that stretch's ordering claimed only; no owner and not current", async () => {
    const m = await moving(ETHEREUM, 68);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, null)),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], m.through);
    expect(r.history).toMatchObject({ status: "valid", entries: 4 });
    expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null });
    // P9.29: the entries accepted on the unread chain are neither attested nor proven.
    expect(r.evm!.stretches[0]).toMatchObject({ chain: ROBINHOOD, status: "unverified", ordering: "claimed", entries: [m.anchoring.versionId, m.move.versionId] });
    expect(r.ordering).toBe("claimed");
    expect(r.reasons).toContain("move-unconfirmed");
    expect(r.current).toBe(false);
  });

  test("C12-274: 'A chain the Original left later replaces the block that held the departure': finality failure there; move unconfirmed", async () => {
    const m = await moving(ETHEREUM, 69);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)], { finalized: 1100, blockHashes: [{ number: 1000, hash: blockHash(ROBINHOOD, 1000, 3) }] })),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { retained: [{ chain: ROBINHOOD, number: 1000, hash: blockHash(ROBINHOOD, 1000) }] });
    expect(r.evm!.stretches[0].finality).toBe("failed");
    expect(r.evm).toMatchObject({ move: "unconfirmed", owner: null, warnings: ["authoritative-source-changed"] });
    expect(r.reasons).toEqual(expect.arrayContaining(["move-unconfirmed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
  });

  test("C12-289 (changed at a3ffdc1), C12-312: 'Departure final, destination chain cannot be read': departure finalized, destination unreachable; missing evidence; no arrival claimed; at most the entries before the first anchoring entry", async () => {
    const m = await moving(ETHEREUM, 70);
    for (const dest of [[], [token(m.dest, two(ETHEREUM, null, { owner: CAROL }))]]) {
      const r = await verify(m.alice, [token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])), ...dest], m.through);
      missingEvidence(r);
      expect(r.history.entries).toBe(2);
      expect(r.evm).toMatchObject({ status: "unverified", destination: m.dest, arrival: "unknown", owner: null });
      expect(r.evm!.stretches[0].departure).toMatchObject({ index: 1, versionId: m.move.versionId, destination: m.dest });
      expect(r.evm!.stretches[0].block).toEqual({ number: 1000, hash: blockHash(ROBINHOOD, 1000) });
      expect(r.evm!.stretches[1]).toMatchObject({ token: m.dest, status: "unverified", missing: expect.objectContaining({ code: expect.any(String) }) });
      expect(r.reasons).toContain("evm-destination-unreachable");
      expect(r.reasons).not.toContain("departed-not-arrived");
    }
  });

  test("C12-275: 'Move made to a proven chain that a later revision reclassifies operator': still accepted, judged at the departure; reported under the current class", async () => {
    const m = await moving(BASE, 71);
    const revised: EvmAnchorPin = {
      ...PIN,
      chains: EVM_CHAINS.map((c) => (c.chain !== BASE ? c : { ...c, classes: [{ from: Date.UTC(2026, 0, 1), class: "exit-protected" as const }, { from: Date.UTC(2026, 9, 20), class: "operator" as const }] })),
    };
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(BASE, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { pin: revised });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.evm?.status).toBe("anchored");
    expect(r.evm!.stretches[1]).toMatchObject({ chain: BASE, class: "operator", describes: "attested-by-operator" });
    expect(r.evm!.owner?.describes).toBe("attested-by-operator");
  });

  test("C12-268: 'Move entry to a chain the verifier's revision of P14.22 does not list': unsupported, not invalid", async () => {
    const optimism: ListedChain = { name: "OP Mainnet", chain: "eip155:10", chainId: 10n, genesisHash: "0x" + "7a".repeat(32), classes: [{ from: 0, class: "exit-protected" }] };
    const devnet: EvmAnchorPin = { ...PIN, chains: [...EVM_CHAINS, optimism] };
    const o = await original(ROBINHOOD, 72);
    const dest = derivedTokenAlias(o.id, { chain: "eip155:10", minter: C }, PIN);
    const move = await updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: "eip155:10", minter: C }, aliases: [dest], evm: devnet });
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, move)]))]);
    expect(r.evm).toMatchObject({ status: "unsupported", unsupported: { code: "EVM_CHAIN_NOT_LISTED" } });
    expect(r.history.status).not.toBe("invalid");
    expect(r.current).toBe(false);
  });

  test("C12-295: 'Move entry's signing key removed, or its signer DID deactivated, after the departure and before the arrival': arrival accepted", async () => {
    for (const how of ["rotate", "deactivate"] as const) {
      const m = await moving(ETHEREUM, how === "rotate" ? 73 : 74);
      m.alice.timeOverride = iso(TS0 + 300);
      if (how === "rotate") await m.alice.rotate([{ fragment: "next", signer: seeded(75) }]);
      else await m.alice.deactivate();
      const r = await verify(m.alice, [
        token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
        token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
      ]);
      expect(r.evm?.status, how).toBe("anchored");
      expect(r.evm!.stretches[1].anchor?.versionId).toBe(m.move.versionId);
      expect(r.evm!.owner?.address).toBe(CAROL);
    }
  });

  test("C12-296: 'Move entry published as a departure when its signing key is not valid at the departure's inscription time': rejected; not departed", async () => {
    const m = await moving(ETHEREUM, 76);
    m.alice.timeOverride = iso(TS0 + 300);
    await m.alice.rotate([{ fragment: "next", signer: seeded(77) }]);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move, TS0 + 600)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 900)], { owner: CAROL })),
    ]);
    expect(r.evm!.stretches).toHaveLength(1);
    expect(r.evm!.stretches[0].departure).toBeNull();
    expect(r.evm!.stretches[0].ignored).toContainEqual(expect.objectContaining({ index: 1, reason: "author-key-not-valid-at-inscription-time" }));
    expect(r.head).toBe(m.anchoring.versionId);
  });

  test("C12-301: 'Original that moved to Bitcoin grants a did:btco editor in or after the move entry': accepted by the state rules", async () => {
    const o = await original(ROBINHOOD, 78);
    const grant = [{ did: "did:btco:reg:5", name: true, metadata: false, resource: false }];
    const move = await o.next(o.anchoring, { anchor: null, aliases: [SAT], editors: grant });
    expect((move.state as { asset: { editors?: unknown } }).asset.editors).toEqual(grant);
  });
});

describe("P3.9, P14.18 did:evm resolution", () => {
  test("C12-283: 'did:evm alias resolved, the log accepted on its token listing it': the did:vh, state and report; the document derived", async () => {
    const o = await original(ROBINHOOD, 81);
    const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))] } });
    expect(res.status).toBe("resolved");
    expect(res.original).toBe(o.id);
    expect(res.state?.aliases).toEqual([o.alias]);
    expect(res.chain).toEqual({ chain: ROBINHOOD, name: "Robinhood Chain", class: "operator", describes: "attested-by-operator" });
    expect(res.document).toMatchObject({ id: o.alias, alsoKnownAs: [o.id], service: [expect.objectContaining({ id: `${o.alias}#files` })] });
    expect(res.report?.current).toBe(true);
  });

  test("C12-284: 'did:evm DID of a token with no accepted anchoring publication, or of a token whose accepted log does not list it': resolves to nothing", async () => {
    const o = await original(ROBINHOOD, 82);
    const minted = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, log: o.log, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, []))] } });
    expect(minted).toMatchObject({ status: "not-found", state: null, document: null });
    // Another token on the chain (another minter): the Original's accepted log does not list it.
    const other = derivedTokenAlias(o.id, { chain: ROBINHOOD, minter: C }, PIN);
    const notListed = await resolveDidEvm(other, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, [rec(0, o.log)])), token(other, two(ROBINHOOD, [rec(0, o.log)]))] } });
    expect(notListed.status).toBe("not-found");
    // Another contract: not an Originals anchor at all.
    const elsewhere = `did:evm:4663:0x${"cd".repeat(20)}:${parseEvmAlias(o.alias).tokenId}`;
    expect((await resolveDidEvm(elsewhere, { authors: [], evm: { pin: PIN, tokens: [] } })).status).toBe("not-found");
    // The form is the method's (P14.18).
    await expect(resolveDidEvm(o.alias.replace(PIN.address, PIN.address.toUpperCase().replace("0X", "0x")), { authors: [], evm: { pin: PIN, tokens: [] } })).rejects.toMatchObject({ code: "STATE_ALIASES" });
  });

  test("C12-285: 'did:evm DID of a token the Original has left': reported as moved, naming the alias that replaced it; no state on that token as current", async () => {
    const m = await moving(ETHEREUM, 83);
    const tokens = [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ];
    const left = await resolveDidEvm(m.alias, { authors: [m.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(left).toMatchObject({ status: "moved", original: m.id, replacedBy: m.dest, state: null, document: null });
    const here = await resolveDidEvm(m.dest, { authors: [m.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(here.status).toBe("resolved");
    expect(here.document).toMatchObject({ id: m.dest, alsoKnownAs: [m.id] });
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.22 providers and finality", () => {
  test("C12-325: 'Provider that cannot serve state at the finalized block because finality trails its retained state': not usable for that read; missing evidence", async () => {
    const o = await original(ROBINHOOD, 101);
    const gone: EvmProviderRead = { ...read(ROBINHOOD, null, { provider: "rpc-b", codeHash: null, owner: null }), stateUnavailable: true };
    // Beside a provider that served it: still missing, never decided on the other provider alone.
    const r = await verify(o.alice, [token(o.alias, [read(ROBINHOOD, [rec(0, o.log)]), gone])], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].missing?.code).toBe("EVM_STATE_UNAVAILABLE");
    // Never unsupported for its absent code, and never not anchored.
    expect(r.evm!.status).not.toBe("unsupported");
    expect(r.history.entries).toBe(2);
  });

  test("C12-326: 'Provider read at its own, later finalized block, compared with the other provider at the lower block': not evidence for the comparison", async () => {
    const o = await original(ROBINHOOD, 102);
    const r = await verify(o.alice, [token(o.alias, [
      read(ROBINHOOD, [rec(0, o.log)], { finalized: 1000 }),
      read(ROBINHOOD, [rec(0, o.log)], { provider: "rpc-b", finalized: 1004 }), // read at 1004, its own finalized block
    ])], o.log);
    missingEvidence(r);
    expect(r.evm!.stretches[0].missing?.code).toBe("EVM_READ_NOT_AT_FINALIZED");
  });

  test("C12-327: 'Verification repeated with no evidence of a finality failure': earlier finalized hashes need not be read again; when evidence appears, a warning, and retained results resting on that block are discarded", async () => {
    const o = await original(ROBINHOOD, 103);
    const e4 = await o.next(o.anchoring, { name: "Published on the replaced fork" });
    // A first verification at block 1000, on what later turns out to be a replaced fork.
    const first = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, e4)]))]);
    expect(first.current).toBe(true);
    const retained = { original: first.retain.original!, authors: first.retain.authors, anchor: first.retain.anchor! };
    const checkpoints = first.retain.evmCheckpoints!;
    expect(checkpoints).toEqual([expect.objectContaining({ token: o.alias, records: 2, block: { number: 1000, hash: blockHash(ROBINHOOD, 1000) }, head: e4.versionId })]);
    // Later, at block 1200, with no evidence about block 1000: finality is assumed; nothing is re-read.
    const assumed = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, e4)], { finalized: 1200 }))], undefined, { retained: first.retain.evm! });
    expect(assumed.evm!.stretches[0].finality).toBe("unchecked");
    expect(assumed.evm!.warnings).toEqual([]);
    expect(assumed.current).toBe(true);
    // A provider reports another hash for block 1000: the fork that held record 1 was replaced.
    const replaced = blockHash(ROBINHOOD, 1000, 9);
    const r = await verifyOriginal({
      authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), retained,
      evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, [rec(0, o.log)], { finalized: 1200, blockHashes: [{ number: 1000, hash: replaced }] }))], retained: first.retain.evm, checkpoints },
    });
    expect(r.evm!.warnings).toEqual(["authoritative-source-changed"]);
    expect(r.evm!.stretches[0]).toMatchObject({ finality: "failed", uniqueness: { status: "not-established" } });
    expect(r.reasons).toEqual(expect.arrayContaining(["authoritative-source-changed", "evm-finality-failed"]));
    expect(r.current).toBe(false);
    // Discarded: the retained head e4, the checkpoint at block 1000 and the block itself.
    expect(r.retain.original).toBe(o.anchoring.versionId);
    expect(r.retain.evm).toEqual([{ chain: ROBINHOOD, number: 1200, hash: blockHash(ROBINHOOD, 1200) }]);
    expect(r.retain.evmCheckpoints ?? []).toEqual([]);
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.25 checkpoints", () => {
  test("C12-328: 'Token with many records, verifier holding a checkpoint': MAY resume from the checkpoint and read only later records; no record cap", async () => {
    const o = await original(ROBINHOOD, 104);
    const e4 = await o.next(o.anchoring, { name: "Four" });
    const e5 = await o.next(e4, { name: "Five" });
    const e6 = await o.next(e5, { name: "Six" });
    const r0 = rec(0, o.log);
    const early = [r0, rec(1, e4), sameBody(2, e5, r0)];
    const first = await verify(o.alice, [token(o.alias, two(ROBINHOOD, early))]);
    expect(first.head).toBe(e5.versionId);
    const [cp] = first.retain.evmCheckpoints!;
    expect(cp).toMatchObject({ token: o.alias, records: 3, head: e5.versionId, anchor: { index: 0, versionId: o.anchoring.versionId }, departed: false });
    // Later: only records 3 and on are read, at a later block; record 3 refers to record 0's body.
    const later = [sameBody(3, e6, r0, TS0 + 600)];
    const resumed = await verifyOriginal({
      log: [...o.log, e4, e5], authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d),
      evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, later, { finalized: 1300 }).map((x) => ({ ...x, from: 3 })))], checkpoints: [cp] },
    });
    expect(resumed.history.status, JSON.stringify(resumed.history.failure)).toBe("valid");
    expect(resumed.head).toBe(e6.versionId);
    expect(resumed.current, JSON.stringify(resumed.reasons)).toBe(true);
    const s = resumed.evm!.stretches[0];
    expect(s.resumedFrom).toEqual({ records: 3, block: cp.block });
    expect(s.anchor).toMatchObject({ index: 0, versionId: o.anchoring.versionId });
    expect(s.accepted.map((p) => [p.index, p.versionId])).toEqual([[1, e4.versionId], [2, e5.versionId], [3, e6.versionId]]);
    expect(resumed.retain.evmCheckpoints).toEqual([expect.objectContaining({ records: 4, head: e6.versionId, block: { number: 1300, hash: blockHash(ROBINHOOD, 1300) } })]);
    // A later read with no checkpoint, or no copy holding its head, is missing evidence, never decided on what was read.
    const reads = two(ROBINHOOD, later, { finalized: 1300 }).map((x) => ({ ...x, from: 3 }));
    const none = await verify(o.alice, [token(o.alias, reads)], [...o.log, e4, e5]);
    missingEvidence(none);
    expect(none.evm!.stretches[0].missing?.code).toBe("EVM_RECORDS_UNREADABLE");
    const nocopy = await verifyOriginal({ authors: [o.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), evm: { pin: PIN, tokens: [token(o.alias, reads)], checkpoints: [cp] } });
    expect(nocopy.evm?.status).not.toBe("anchored");
    expect(nocopy.current).toBe(false);
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.19, P9.23 not anchored", () => {
  test("C12-331: 'Signed anchoring entry not published, genesis `anchor` member alone, or token minted with no publication': not anchored", async () => {
    const o = await original(ROBINHOOD, 105);
    const cases: Array<[LogEntry[], EvmProviderRead[]]> = [
      [o.log, two(ROBINHOOD, [], { owner: HOLDER })], // the anchoring entry signed, the token minted, nothing published
      [o.log, two(ROBINHOOD, [], { owner: null })], // the anchoring entry signed, no token
      [[o.genesis], two(ROBINHOOD, [], { owner: null })], // only the genesis anchor member
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
    const o = await original(ROBINHOOD, 106);
    const junk: EvmRecord = { index: 0, timestamp: TS0, metadataLength: 3, bodyLength: 1, bodyOf: 0, mediaType: "text/plain", metadata: Uint8Array.of(0x83, 1, 2), body: Uint8Array.of(0x41) };
    const tokens = [token(o.alias, two(ROBINHOOD, [junk], { owner: CAROL }))];
    const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(res).toMatchObject({ status: "not-found", original: null, state: null, document: null });
    const r = await verifyOriginal({ authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(r.evm?.status).toBe("not-anchored");
    expect(r.evm?.owner).toBeNull();
    expect(r.current).toBe(false);
  });
});

describe("originals-spec PR 59 a3ffdc1: P9.29 moves", () => {
  test("C12-313: 'Verifier that retained the anchor on the token left, then reads a verified move': a move with its source and destination; not a conflicting anchor or a change of anchor", async () => {
    const m = await moving(ETHEREUM, 107);
    const before = await verify(m.alice, [token(m.alias, two(ROBINHOOD, [rec(0, m.log)]))]);
    expect(before.retain.anchor?.sat).toBe(m.alias);
    const retained = { original: before.retain.original!, authors: before.retain.authors, anchor: before.retain.anchor! };
    const r = await verifyOriginal({
      authors: [m.alice.evidence()], now: NOW, bytes: (d) => describedBytes(d), retained,
      evm: { pin: PIN, tokens: [
        token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)], { finalized: 1100 })),
        token(m.dest, two(ETHEREUM, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
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
    const o = await original(ROBINHOOD, 108);
    const dest = derivedTokenAlias(o.id, { chain: ETHEREUM, minter: C }, PIN);
    const toEth = await o.next(o.anchoring, { anchor: { chain: ETHEREUM, minter: C }, aliases: [dest] });
    const toBtc = await o.next(toEth, { anchor: null, aliases: [SAT] });
    const throughEth = [...o.log, toEth];
    const all = [...throughEth, toBtc];
    const r = await verify(o.alice, [
      token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, toEth)])),
      token(dest, two(ETHEREUM, [rec(0, throughEth, TS0 + 600), rec(1, toBtc, TS0 + 612)], { owner: CAROL })),
    ], undefined, {
      bitcoin: [satRead([{ id: "cd".repeat(32) + "i0", height: 100, transactionIndex: 1, inscriptionIndex: 0, confirmations: 6, inscriptionTime: (TS0 + 7200) * 1000, ...carrying(all) } as Omit<SatInscription, "sat" | "network">])],
    });
    expect(r.evm).toMatchObject({ status: "moved-to-bitcoin", move: "confirmed" });
    expect(r.evm!.carried).toEqual({ entries: [o.genesis.versionId, o.v2.versionId], ordering: "claimed" });
    expect(r.evm!.stretches.map((s) => s.ordering)).toEqual(["attested-by-operator", "proven"]);
    const atV2 = await verify(o.alice, [
      token(o.alias, two(ROBINHOOD, [rec(0, o.log), rec(1, toEth)])),
      token(dest, two(ETHEREUM, [rec(0, throughEth, TS0 + 600), rec(1, toBtc, TS0 + 612)], { owner: CAROL })),
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
      chains: EVM_CHAINS.map((c) => (c.chain !== BASE ? c : { ...c, classes: [{ from: Date.UTC(2026, 0, 1), class: "exit-protected" as const }, { from: Date.UTC(2026, 9, 20), class: "operator" as const }] })),
    };
    const o = await original(ROBINHOOD, 109);
    const dest = derivedTokenAlias(o.id, { chain: BASE, minter: C }, revised);
    // Prepared now, with no departure record: Base is judged by its current class, operator, so the move is not upward.
    await expect(updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: BASE, minter: C }, aliases: [dest], evm: revised }))
      .rejects.toMatchObject({ code: "STATE_MOVE_LAYER" });
    // The same move, published while Base was exit-protected: once the departure record is read, its timestamp decides (C12-275).
    const m = await moving(BASE, 110);
    const r = await verify(m.alice, [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(BASE, [rec(0, m.through, TS0 + 600)], { owner: CAROL })),
    ], undefined, { pin: revised });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.evm!.stretches[0].classAtDeparture).toBe("operator");
  });
});

describe("originals-spec PR 59 a3ffdc1: P14.20 records, P14.21 per-chain address", () => {
  test("C12-311: 'Record that refers to an earlier body': its `bodyLength` is the referred body's length; only its metadata counts toward the 350,000-byte limit", async () => {
    const o = await original(ROBINHOOD, 111);
    const e4 = await o.next(o.anchoring, { name: "Renamed" });
    const r0 = rec(0, o.log);
    // A referring record whose bodyLength is not the referred body's: no publication the pinned contract records.
    const zero = { ...sameBody(1, e4, r0), bodyLength: 0 };
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [r0, zero]))]);
    expect(r.head).toBe(o.anchoring.versionId);
    expect(r.evm!.stretches[0].ignored).toContainEqual({ index: 1, reason: "invalid-body-reference" });
    // 349,999 bytes of metadata referring to a 300,000-byte body is within the limit: decided by its bytes, which were not read here.
    const big: EvmRecord = { index: 1, timestamp: TS0 + 12, metadataLength: 349_999, bodyLength: 300_000, bodyOf: 0, mediaType: r0.mediaType };
    const bigRef = { ...r0, bodyLength: 300_000 };
    const within = await verify(o.alice, [token(o.alias, two(ROBINHOOD, [bigRef, big]))], o.log);
    expect(within.evm!.stretches[0].ignored.find((x) => x.index === 1)?.reason).not.toBe("too-large");
    missingEvidence(within);
  });

  test("P14.18, P14.21 (a3ffdc1): a chain with its own pinned address: the token alias, the read and did:evm use that chain's address; the code hash stays common", async () => {
    const own = "0x" + "ef".repeat(20);
    const perChain: EvmAnchorPin = { ...PIN, addresses: { [ROBINHOOD]: own } };
    const key = seeded(112);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const author = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: at(), name: "Elsewhere", resource: photo("per-chain"), author, sign, anchor: { chain: ROBINHOOD, minter: A }, evm: perChain });
    const id = (genesis.state as { id: string }).id;
    const alias = derivedTokenAlias(id, { chain: ROBINHOOD, minter: A }, perChain);
    expect(parseEvmAlias(alias).contract).toBe(own);
    expect(derivedTokenAlias(id, { chain: ETHEREUM, minter: A }, perChain)).toContain(PIN.address);
    const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [alias], evm: perChain });
    // The common address on that chain is not the token P14.19 derives under this pin.
    const common = derivedTokenAlias(id, { chain: ROBINHOOD, minter: A }, PIN);
    await expect(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [common], evm: perChain })).rejects.toMatchObject({ code: "STATE_ANCHOR_TOKEN" });
    const tokens = [token(alias, two(ROBINHOOD, [rec(0, [genesis, anchoring])]))];
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
    const o = await original(ROBINHOOD, 113);
    const other = await original(ROBINHOOD, 114);
    const junk: EvmRecord = { index: 0, timestamp: TS0, metadataLength: 3, bodyLength: 1, bodyOf: 0, mediaType: "text/plain", metadata: Uint8Array.of(0x83, 1, 2), body: Uint8Array.of(0x41) };
    for (const first of [junk, rec(0, other.log)]) {
      const records = [first, rec(1, o.log)];
      const res = await resolveDidEvm(o.alias, { authors: [o.alice.evidence(), other.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, records))] } });
      expect(res.status, JSON.stringify(res.report?.reasons)).toBe("resolved");
      expect(res.original).toBe(o.id);
      expect(res.report?.evm?.stretches[0].anchor).toMatchObject({ index: 1, versionId: o.anchoring.versionId });
    }
    // Arrival: on a token reached by a move, the arrival publication names the candidate.
    const m = await moving(ETHEREUM, 115);
    const tokens = [
      token(m.alias, two(ROBINHOOD, [rec(0, m.log), rec(1, m.move)])),
      token(m.dest, two(ETHEREUM, [rec(0, other.log, TS0 + 500), rec(1, m.through, TS0 + 600)], { owner: CAROL })),
    ];
    const here = await resolveDidEvm(m.dest, { authors: [m.alice.evidence(), other.alice.evidence()], now: NOW, evm: { pin: PIN, tokens } });
    expect(here).toMatchObject({ status: "resolved", original: m.id });
  });
});

describe("originals-spec PR 59: tokenURI and carried files from publications", () => {
  test("C12-286: 'Document returned by the token's tokenURI, offered as the did:evm DID document': not used (P3.9, P3.8)", async () => {
    const o = await original(ROBINHOOD, 91);
    const forged = {
      "@context": ["https://www.w3.org/ns/did/v1"], id: o.alias, alsoKnownAs: ["did:vh:QmForgedForgedForgedForgedForgedForgedForged1"],
      service: [{ id: `${o.alias}#files`, type: "OriginalsFiles", serviceEndpoint: "https://evil.example/files/" }],
      verificationMethod: [{ id: `${o.alias}#k`, type: "Multikey", controller: o.alias, publicKeyMultibase: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }],
    };
    const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify(forged))}`;
    const withUri = (reads: EvmProviderRead[]) => reads.map((r) => ({ ...r, tokenURI, document: forged }) as EvmProviderRead);
    const base = { authors: [o.alice.evidence()], now: NOW };
    // Offered beside an accepted log: the derived document, never the offered one.
    const plain = await resolveDidEvm(o.alias, { ...base, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, [rec(0, o.log)]))] } });
    const offered = await resolveDidEvm(o.alias, { ...base, document: forged, tokenURI, evm: { pin: PIN, tokens: [token(o.alias, withUri(two(ROBINHOOD, [rec(0, o.log)])))] } } as never);
    expect(offered.status).toBe("resolved");
    expect(canonicalize(offered.document as JsonValue)).toBe(canonicalize(plain.document as JsonValue));
    expect(offered.document).toMatchObject({ id: o.alias, alsoKnownAs: [o.id] });
    expect(JSON.stringify(offered.document)).not.toContain("evil.example");
    expect(offered.original).toBe(o.id);
    // Offered for a token with no accepted anchoring publication: it resolves to nothing, whatever tokenURI says.
    const minted = await resolveDidEvm(o.alias, { ...base, document: forged, tokenURI, evm: { pin: PIN, tokens: [token(o.alias, withUri(two(ROBINHOOD, [])))] } } as never);
    expect(minted).toMatchObject({ status: "not-found", document: null, state: null, original: null });
  });

  test("C12-291: 'Writer making a carried file from an accepted publication's body and entries': allowed for an EVM publication, as for any accepted checkpoint (P7.16, P7.15)", async () => {
    const o = await original(ROBINHOOD, 92);
    const v3 = await o.next(o.anchoring, { resource: photo("dusk v3 92") });
    const records = [rec(0, o.log), rec(1, v3)];
    const r = await verify(o.alice, [token(o.alias, two(ROBINHOOD, records))]);
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
    const read = await readCarriedFile(file, { authors: [o.alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [token(o.alias, two(ROBINHOOD, records))] } });
    expect(read.verified, JSON.stringify(read.reasons)).toEqual({ log: true, version: true });
    expect(read.anchoring.status).toBe("evm");
    expect(read.current).toBe(true);
    // The carrier is never part of what is published: removing it gives the body back (P7.16).
    expect(file.length).toBeGreaterThan(body.length);
    expect(file.slice(0, body.length)).toEqual(body);
  });
});
