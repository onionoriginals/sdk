/**
 * EVM anchoring adapters (originals-spec PR 59, EXPERIMENTAL): the ABI layer,
 * the evidence reader (P9.21, P9.22, P9.25), the writer's refusals and
 * labels (P9.27, P14.20), and the P9.27 / P9.29 disclosures. Section 12 rows
 * are cited by C12 id and the row's first column. The
 * end-to-end path against a real EVM is tests/integration/evm-anvil.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { localSigner } from "@originals/vh/crypto";
import { serializeLog, signWith } from "@originals/vh/log";
import {
  EVM_CHAINS,
  createOriginal,
  derivedTokenAlias,
  evmAliasOf,
  resourceDigest,
  tokenIdOf,
  updateOriginal,
  type EvmAnchorPin,
  type ListedChain,
} from "@originals/vh/originals";
import { OriginalsError } from "@originals/vh";
import { decodeArgs, encodeArgs, encodeCall, eventTopic, keccakHex, toHex } from "../../../src/originals/evm-abi.js";
import {
  evmGenesisNotice,
  evmMoveNotice,
  evmPublicationStatus,
  mintEvmToken,
  prepareEvmPublication,
  readEvmToken,
  recordExceedsLimits,
  type EvmWallet,
} from "../../../src/originals/evm.js";
import { inscriptionMetadata } from "../../../src/originals/inscription.js";
import { Author, bytes, seed } from "./helpers.js";
import { blockHash, fakeNetwork, fakeProvider, type Call, type FakeChain, type FakeRecord } from "./evm-fake.js";

const CODE = bytes("pinned anchor runtime code");
const ADDRESS = "0x92aa49faf844dee74ab85de1a42a0705e8ea8b08";
const GENESIS = "0x" + "0d".repeat(32);
const DEVNET: ListedChain = { name: "Devnet", chain: "eip155:31337", chainId: 31337n, genesisHash: GENESIS, classes: [{ from: 0, class: "operator" }] };
const PIN: EvmAnchorPin = { address: ADDRESS, codeHash: keccakHex(CODE), chains: [...EVM_CHAINS, DEVNET] };
const TOKEN = 77n;
const ALIAS = evmAliasOf("eip155:31337", ADDRESS, TOKEN);
const HOLDER = "0x" + "a1".repeat(20);

function chain(over: Partial<FakeChain> = {}, records: FakeRecord[] = []): FakeChain {
  return { chainId: 31337n, genesisHash: GENESIS, finalized: 10, latest: 12, code: CODE, address: ADDRESS, owners: new Map([[TOKEN, HOLDER]]), records: new Map([[TOKEN, records]]), ...over };
}

const rec = (block: number, metadata: Uint8Array, body: Uint8Array, extra: Partial<FakeRecord> = {}): FakeRecord => ({ block, timestamp: 1_800_000_000 + block, mediaType: "image/png", metadata, body, ...extra });

async function rejects(p: Promise<unknown> | (() => unknown), code: string, category?: string) {
  let error: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).code).toBe(code);
  if (category) expect((error as OriginalsError).category).toBe(category);
  return error as OriginalsError;
}

describe("ABI layer (hand-rolled; vectors from Foundry's cast)", () => {
  test("calldata matches cast calldata", () => {
    expect(toHex(encodeCall("publish(uint256,string,bytes,bytes)", ["uint256", "string", "bytes", "bytes"], [5n, "image/png", Uint8Array.of(0x80, 0x01), Uint8Array.of(1, 2, 3, 4, 5)]))).toBe(
      "0x3256877f0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000009696d6167652f706e6700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002800100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050102030405000000000000000000000000000000000000000000000000000000",
    );
    expect(toHex(encodeCall("publishSameBody(uint256,bytes,uint32)", ["uint256", "bytes", "uint32"], [5n, Uint8Array.of(0xa1), 2]))).toBe(
      "0x29944d4d0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001a100000000000000000000000000000000000000000000000000000000000000",
    );
    expect(toHex(encodeCall("commit(bytes32,string,uint32)", ["bytes32", "string", "uint32"], [new Uint8Array(32).fill(0xab), "text/plain", 7]))).toBe(
      "0x5d4168ffabababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000000a746578742f706c61696e00000000000000000000000000000000000000000000",
    );
    expect(eventTopic("Published(uint256,uint32)")).toBe("0x84aa9a99807ead41342ca4e48223d1822eefbffacb56b587ea2759e96dba3083");
    expect(eventTopic("UploadBegun(bytes32,uint256,address)")).toBe("0x8375c199f66db5da537ea5b6851eea4db0b8ed7968b558fc405440a5491e4a12");
  });

  test("decodes cast abi-encode of publication()'s return, and rejects malformed answers", () => {
    const data =
      "000000000000000000000000000000000000000000000000000000006b49d20000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000009696d6167652f706e670000000000000000000000000000000000000000000000";
    const types = ["uint64", "uint32", "uint32", "uint32", "string"] as const;
    const raw = Uint8Array.from(Buffer.from(data, "hex"));
    expect(decodeArgs(types, raw)).toEqual([1_800_000_000n, 3n, 4n, 0n, "image/png"]);
    expect(() => decodeArgs(types, raw.slice(0, 100))).toThrow(/shorter/);
    const long = Uint8Array.from(raw);
    long[32 * 6 - 1] = 0xff; // the string's length runs past the data
    expect(() => decodeArgs(types, long)).toThrow(/past the data/);
    const wide = encodeArgs(["uint256"], [1n << 40n]);
    expect(() => decodeArgs(["uint32"], wide)).toThrow(/out of range/);
    expect(() => encodeArgs(["uint32"], [2 ** 32])).toThrow(/not a uint32/);
  });
});

describe("readEvmToken (P9.21, P9.22, P9.25)", () => {
  const m0 = bytes("metadata-0"), b0 = bytes("body-0-bytes");
  const m1 = bytes("metadata-1");
  const records = () => [rec(3, m0, b0), rec(9, m1, new Uint8Array(), { bodyOf: 0 }), rec(11, bytes("metadata-2"), bytes("later"))];

  test("two providers: the lower finalized block is common, both read at its hash, records above it observed", async () => {
    const callsA: Call[] = [], callsB: Call[] = [];
    const fetch = fakeNetwork({ a: fakeProvider(chain({ finalized: 10 }, records()), callsA), b: fakeProvider(chain({ finalized: 12 }, records()), callsB) });
    const { evidence, failures, commonBlock } = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["a", { url: "b", name: "provider B" }], fetch, observe: true });
    expect(failures).toEqual([]);
    expect(commonBlock).toBe(10);
    expect(evidence.chain).toBe("eip155:31337");
    expect(evidence.alias).toBe(ALIAS);
    expect(evidence.reads.map((r) => r.provider)).toEqual(["a", "provider B"]);
    for (const r of evidence.reads) {
      expect(r.chainId).toBe(31337n);
      expect(r.genesisHash).toBe(GENESIS);
      expect(r.block).toEqual({ number: 10, hash: blockHash({}, 10) });
      expect(r.codeHash).toBe(PIN.codeHash);
      expect(r.owner).toBe(HOLDER);
      expect(r.records!.map((x) => x.index)).toEqual([0, 1]);
      expect(r.records![0]).toEqual({ index: 0, timestamp: 1_800_000_003, metadataLength: m0.length, bodyLength: b0.length, bodyOf: 0, mediaType: "image/png", metadata: m0, body: b0 });
      // A record that refers to a body has the referred record's bytes (P14.20).
      expect(r.records![1]).toMatchObject({ index: 1, bodyOf: 0, bodyLength: b0.length, metadata: m1, body: b0 });
      expect(r.observed!.map((x) => [x.index, x.metadata])).toEqual([[2, undefined]]);
    }
    expect(evidence.reads.map((r) => r.finalized)).toEqual([10, 12]);
    // C12-261: event logs are never evidence (P9.25).
    expect([...callsA, ...callsB].some((c) => c.method === "eth_getLogs")).toBe(false);
    // The referred body was not read again.
    expect(callsA.filter((c) => c.name === "body").length).toBe(1);
  });

  test("C12-240: \"Provider reporting the listed chain ID whose block 0 has another hash\": not that chain; no state read, and it does not lower the common block", async () => {
    const calls: Call[] = [];
    const fetch = fakeNetwork({ good: fakeProvider(chain({ finalized: 10 }, records())), other: fakeProvider(chain({ finalized: 4, genesisHash: "0x" + "ee".repeat(32), fork: "other" }, records()), calls) });
    const { evidence, commonBlock } = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["good", "other"], fetch });
    expect(commonBlock).toBe(10);
    const other = evidence.reads.find((r) => r.provider === "other")!;
    expect(other).toMatchObject({ genesisHash: "0x" + "ee".repeat(32), codeHash: null, owner: null, records: null, finalized: 4 });
    expect(calls.filter((c) => c.method === "eth_call" || c.method === "eth_getCode")).toEqual([]);
  });

  test("C12-241: \"Code at the anchor contract address with another runtime code hash, or none\": reported with its hash, and nothing else is read", async () => {
    for (const code of [bytes("other code"), new Uint8Array()]) {
      const calls: Call[] = [];
      const { evidence } = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["p"], fetch: fakeNetwork({ p: fakeProvider(chain({ code }, records()), calls) }) });
      expect(evidence.reads[0].codeHash).toBe(code.length ? keccakHex(code) : null);
      expect(evidence.reads[0].records).toBeNull();
      expect(evidence.reads[0].owner).toBeNull();
      expect(calls.some((c) => c.method === "eth_call")).toBe(false);
    }
  });

  test("C12-255: P9.25: a record over the limits from its own fields has no bytes read, and makes nothing missing", async () => {
    const calls: Call[] = [];
    const over = [
      rec(1, m0, b0),
      rec(2, bytes("x"), bytes("y"), { metadataLength: 200_000, bodyLength: 150_001 }), // 350,001 stored
      rec(3, bytes("x"), bytes("y"), { mediaType: "a".repeat(256) }),
      rec(4, bytes("z"), new Uint8Array(), { bodyOf: 0, metadataLength: 350_001 }), // refers; metadata alone over
      rec(5, bytes("ok"), new Uint8Array(), { bodyOf: 0 }),
    ];
    const { evidence, failures } = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["p"], fetch: fakeNetwork({ p: fakeProvider(chain({}, over), calls) }) });
    expect(failures).toEqual([]);
    const rs = evidence.reads[0].records!;
    expect(rs.map((r) => r.metadata !== undefined)).toEqual([true, false, false, false, true]);
    for (const i of [1, 2, 3]) expect(calls.some((c) => (c.name === "metadata" || c.name === "body") && Number(c.args![1]) === i)).toBe(false);
    expect(recordExceedsLimits({ index: 0, metadataLength: 100_000, bodyLength: 250_000, bodyOf: 0, mediaType: "x" })).toBe(false);
    expect(recordExceedsLimits({ index: 1, metadataLength: 350_000, bodyLength: 300_000, bodyOf: 0, mediaType: "x" })).toBe(false);
  });

  test("C12-256: ranges: bytes are read in calls of rangeBytes; a provider returning a short range is inconsistent and its records are missing", async () => {
    const big = Uint8Array.from({ length: 1_000 }, (_, i) => i % 251);
    const calls: Call[] = [];
    const ok = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["p"], rangeBytes: 300, fetch: fakeNetwork({ p: fakeProvider(chain({}, [rec(1, m0, big)]), calls) }) });
    expect(ok.evidence.reads[0].records![0].body).toEqual(big);
    expect(calls.filter((c) => c.name === "body").map((c) => [Number(c.args![2]), Number(c.args![3])])).toEqual([[0, 300], [300, 300], [600, 300], [900, 100]]);
    const short = await readEvmToken({ alias: ALIAS }, { pin: PIN, providers: ["p"], rangeBytes: 300, fetch: fakeNetwork({ p: fakeProvider(chain({ shortRanges: true }, [rec(1, m0, big)])) }) });
    expect(short.evidence.reads[0].records).toBeNull();
    expect(short.failures[0].code).toBe("EVM_PROVIDER_INCONSISTENT");
  });

  test("a provider that fails is a failure, not a read; a token never minted has no owner and no records", async () => {
    const { evidence, failures } = await readEvmToken({ alias: evmAliasOf("eip155:31337", ADDRESS, 5n) }, { pin: PIN, providers: ["up", "down"], fetch: fakeNetwork({ up: fakeProvider(chain()), down: fakeProvider(chain({ down: true })) }) });
    expect(evidence.reads.map((r) => r.provider)).toEqual(["up"]);
    expect(evidence.reads[0]).toMatchObject({ owner: null, records: [] });
    expect(failures).toEqual([expect.objectContaining({ provider: "down", code: "EVM_PROVIDER_UNAVAILABLE" })]);
  });

  test("the token derives from the Original and its anchor member (P14.19); an alias of another contract, or an unlisted chain, is refused", async () => {
    const did = "did:vh:QmTokenIdVectorTokenIdVectorTokenIdVectorAb";
    const anchor = { chain: "eip155:31337", minter: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" };
    const { evidence } = await readEvmToken({ original: did, anchor }, { pin: PIN, providers: ["p"], fetch: fakeNetwork({ p: fakeProvider(chain()) }) });
    expect(evidence.alias).toBe(evmAliasOf("eip155:31337", ADDRESS, tokenIdOf(did, anchor.minter)));
    await rejects(readEvmToken({ alias: evmAliasOf("eip155:31337", "0x" + "99".repeat(20), 1n) }, { pin: PIN, providers: ["p"] }), "EVM_ALIAS_CONTRACT");
    await rejects(readEvmToken({ alias: evmAliasOf("eip155:999", ADDRESS, 1n) }, { pin: PIN, providers: ["p"] }), "EVM_CHAIN_NOT_LISTED", "unsupported-profile");
  });
});

// ------------------------------------------------------------------ logs for writer and notice tests

const KEY = seed(41);
async function anchoredLog(chainId = "eip155:31337", minter = "0x" + "a1".repeat(20), photo = bytes("photo v1")) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sign = signWith(localSigner("Ed25519", KEY), { cryptosuite: "eddsa-jcs-2022", verificationMethod: alice.ref("orig").verificationMethod });
  const author = alice.ref("orig");
  const resource = { mediaType: "image/png", size: photo.length, digest: resourceDigest(photo) };
  const anchor = { chain: chainId, minter };
  const genesis = await createOriginal({ versionTime: "2026-11-11T12:00:00Z", name: "Harbor at dusk", resource, author, sign, anchor, evm: PIN });
  const did = genesis.state.id as string;
  const alias = derivedTokenAlias(did, anchor, PIN);
  const anchoring = await updateOriginal(genesis, { versionTime: "2026-11-11T12:00:01Z", author, sign, aliases: [alias], evm: PIN });
  const lines = serializeLog([genesis, anchoring]).split("\n").filter(Boolean);
  return { did, alias, anchor, lines, photo, resource };
}

describe("P9.27 / P9.29 disclosures", () => {
  test("C12-278: \"Writer creating an Original with an EVM `anchor`\": told the first chain is permanent, upward only, stays dependent, its trust class, chain lifetime, the minter", () => {
    const minter = "0x" + "a1".repeat(20);
    const n = evmGenesisNotice({ chain: "eip155:4663", minter }, PIN);
    expect(n.chain).toEqual({ chain: "eip155:4663", name: "Robinhood Chain", trustClass: "operator", layer: "attested" });
    expect(n.layersAbove).toEqual(["proven", "bitcoin"]);
    expect(n.points[0]).toMatch(/permanent.*attested chain.*only upward.*never sideways, down or back/);
    expect(n.points[1]).toMatch(/stays dependent on every chain/);
    expect(n.points[2]).toMatch(/trust class operator.*attested by its operator, never as proven/);
    expect(n.points[3]).toMatch(/last only as long as Robinhood Chain's nodes keep its state/);
    expect(n.points[4]).toContain(minter);
    expect(n.text).toBe(n.points.join(" "));
    const eth = evmGenesisNotice({ chain: "eip155:1", minter }, PIN);
    expect(eth.chain.layer).toBe("proven");
    expect(eth.layersAbove).toEqual(["bitcoin"]);
    expect(eth.points[2]).toMatch(/proven on that chain/);
    // An unlisted chain, or no pin at all, is unsupported: nothing to disclose because nothing may be written.
    expect(() => evmGenesisNotice({ chain: "eip155:999", minter }, PIN)).toThrow(/not in this verifier's revision/);
  });

  test("C12-277: P9.29: a move notice says irreversible, the layers above, dependence on the chain left, and what becomes public; a sideways or downward move is refused", async () => {
    const { lines, resource } = await anchoredLog();
    const minter = "0x" + "c1".repeat(20);
    const n = evmMoveNotice({ from: { chain: "eip155:4663", minter }, to: { chain: "eip155:1", minter }, lines, version: resource, pin: PIN });
    expect(n.layersAbove).toEqual(["bitcoin"]);
    expect(n.points[0]).toMatch(/cannot be reversed.*Bitcoin/);
    expect(n.points[1]).toMatch(/stays dependent on Robinhood Chain/);
    expect(n.points[2]).toMatch(/public and permanent/);
    expect(n.arrivalBytes).toBe(inscriptionMetadata(lines).length + resource.size);
    const toBitcoin = evmMoveNotice({ from: { chain: "eip155:1", minter }, to: null, lines, version: resource, pin: PIN });
    expect(toBitcoin.layersAbove).toEqual([]);
    expect(toBitcoin.points[2]).toMatch(/on Bitcoin/);
    // Robinhood (operator) to Tempo (consortium): both attested, sideways. Ethereum to Robinhood: down.
    await rejects(() => evmMoveNotice({ from: { chain: "eip155:4663", minter }, to: { chain: "eip155:4217", minter }, lines, version: resource, pin: PIN }), "MOVE_NOT_UPWARD");
    await rejects(() => evmMoveNotice({ from: { chain: "eip155:1", minter }, to: { chain: "eip155:4663", minter }, lines, version: resource, pin: PIN }), "MOVE_NOT_UPWARD");
  });

  test("C12-277: P9.29: the SDK refuses a move whose arrival would exceed 350,000 bytes", async () => {
    const { lines, resource } = await anchoredLog();
    const minter = "0x" + "c1".repeat(20);
    const room = 350_000 - inscriptionMetadata(lines).length;
    expect(evmMoveNotice({ from: { chain: "eip155:4663", minter }, to: null, lines, version: { ...resource, size: room }, pin: PIN }).arrivalBytes).toBe(350_000);
    const e = await rejects(() => evmMoveNotice({ from: { chain: "eip155:4663", minter }, to: null, lines, version: { ...resource, size: room + 1 }, pin: PIN }), "MOVE_ARRIVAL_TOO_LARGE", "limit-exceeded");
    expect(e.details).toEqual({ size: 350_001, limit: 350_000 });
  });
});

describe("writer: checks before sending, and labels (P9.21, P9.27, P14.19, P14.20)", () => {
  const sent: unknown[] = [];
  const wallet = (address: string): EvmWallet => ({ address, sendTransaction: (tx) => (sent.push(tx), Promise.resolve("0x" + "ff".repeat(32))) });
  const ctx = (c: FakeChain, address = "0x" + "a1".repeat(20)) => ({ chain: "eip155:31337", pin: PIN, wallet: wallet(address), rpc: "p", fetch: fakeNetwork({ p: fakeProvider(c) }) });

  test("refuses another provider's chain, other code at the address, and a wallet that is not the minter", async () => {
    const { did, anchor } = await anchoredLog();
    await rejects(mintEvmToken(ctx(chain({ genesisHash: "0x" + "ee".repeat(32) })), { original: did, anchor }), "EVM_WRONG_CHAIN", "unsupported-profile");
    await rejects(mintEvmToken(ctx(chain({ code: bytes("other") })), { original: did, anchor }), "EVM_ANCHOR_CODE", "unsupported-profile");
    await rejects(mintEvmToken(ctx(chain(), "0x" + "b2".repeat(20)), { original: did, anchor }), "EVM_WRONG_MINTER");
    expect(sent).toEqual([]);
  });

  test("refuses a body other than the version the last entry names, and a publication over 350,000 bytes", async () => {
    const { alias, lines } = await anchoredLog();
    await rejects(prepareEvmPublication(ctx(chain()), { alias, lines, body: bytes("photo v2") }), "EVM_BODY_MISMATCH");
    const big = new Uint8Array(350_000);
    const log = await anchoredLog("eip155:31337", "0x" + "a1".repeat(20), big);
    await rejects(prepareEvmPublication(ctx(chain()), { alias: log.alias, lines: log.lines, body: big }), "PUBLICATION_TOO_LARGE", "limit-exceeded");
    expect(sent).toEqual([]);
  });

  test("plans one transaction, a staged upload over maxTxBytes, and refers to a body the token already stores", async () => {
    const { alias, lines, photo } = await anchoredLog();
    const tokenId = BigInt(alias.split(":").pop()!);
    const c = chain({ records: new Map(), owners: new Map([[tokenId, HOLDER]]) });
    const one = await prepareEvmPublication(ctx(c), { alias, lines, body: photo });
    expect(one.plan).toEqual({ kind: "publish" });
    expect(one.sameBodyOf).toBeNull();
    expect(one.metadata).toEqual(inscriptionMetadata(lines));
    expect(one.notice.text).toMatch(/public, last as long as Devnet's nodes keep its state/);
    const staged = await prepareEvmPublication(ctx(c), { alias, lines, body: photo, maxTxBytes: 500 });
    expect(staged.plan).toEqual({ kind: "staged", appends: Math.ceil(staged.storedBytes / 500), commit: "commit" });
    c.records.set(tokenId, [rec(1, bytes("m"), photo)]);
    const same = await prepareEvmPublication(ctx(c), { alias, lines: lines.slice(1), body: photo });
    expect(same.sameBodyOf).toBe(0);
    expect(same.plan).toEqual({ kind: "publishSameBody" });
    expect(same.storedBytes).toBe(same.metadata.length);
    expect((await prepareEvmPublication(ctx(c), { alias, lines, body: photo, sameBody: false })).sameBodyOf).toBeNull();
    c.records.set(tokenId, [rec(1, bytes("m"), bytes("other bytes"))]);
    await rejects(prepareEvmPublication(ctx(c), { alias, lines, body: photo, sameBody: 0 }), "EVM_NOT_STORED_BODY");
  });

  test("P9.27 labels: pending while pooled or in a block not yet finalized, submitted-unobserved otherwise, reverted never pending", async () => {
    const h = (n: number) => "0x" + String(n).padStart(64, "0");
    const c = chain({ finalized: 10, latest: 12, pool: new Set([h(1)]), receipts: new Map([[h(2), { block: 11, status: 1 }], [h(3), { block: 9, status: 1 }], [h(4), { block: 9, status: 0 }]]) });
    const fetch = fakeNetwork({ p: fakeProvider(c) });
    const status = async (hashes: string[]) => (await evmPublicationStatus("p", hashes, { fetch })).status;
    expect(await status([h(1)])).toBe("pending-evm-finality");
    expect(await status([h(2)])).toBe("pending-evm-finality");
    expect(await status([h(3)])).toBe("finalized");
    expect(await status([h(5)])).toBe("submitted-unobserved");
    expect(await status([h(3), h(2)])).toBe("pending-evm-finality");
    expect(await status([h(3), h(5)])).toBe("submitted-unobserved");
    expect(await status([h(4), h(1)])).toBe("reverted");
  });
});
