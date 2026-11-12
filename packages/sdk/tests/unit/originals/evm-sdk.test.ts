/**
 * EVM anchoring through the SDK workflow (originals-spec PR 59, EXPERIMENTAL):
 * `create` with an `anchor` member (P9.19, P9.27), `anchor` listing the
 * token alias, minting and publishing through an injected wallet with the
 * P9.18 checks and labels read through P9.20 and P9.27, moves up a layer
 * (P9.28, P9.29), verification from the configured providers with retained
 * blocks and checkpoints (P9.22, P9.25), commits after anchoring (P9.12) and
 * carried files (P7.15). The chains are fakes (./evm-fake.ts) behind the same
 * JSON-RPC calls as a node; tests/integration/evm-anvil.test.ts runs the
 * workflow on anvil. Section 12 rows are cited by C12 id and the start of
 * the row's first column.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSigner } from "@originals/vh/crypto";
import { parseJson } from "@originals/vh/json";
import { signWith, type LogEntry } from "@originals/vh/log";
import { OriginalsError } from "@originals/vh";
import { EVM_CHAINS, derivedTokenAlias, updateOriginal, type EvmAnchor, type EvmAnchorPin, type ListedChain } from "@originals/vh/originals";
import { keccakHex } from "../../../src/originals/evm-abi.js";
import { evmGenesisNotice, prepareEvmPublication as preparePublication, readEvmToken, submitEvmPublication as submitPublication } from "../../../src/originals/evm.js";
import { FileStore } from "../../../src/originals/fs-store.js";
import { InscriptionClock, MemoryStore, OriginalsSDK, type OriginalsEvmOptions, type OriginalsStore } from "../../../src/originals/index.js";
import { nextPendingEntry, prepareEntryInscription } from "../../../src/originals/bitcoin-writer.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import { Author, bytes, clock, seed } from "./helpers.js";
import { fakeNetwork, fakeProvider, fakeWallet, finalize, type Call, type FakeChain } from "./evm-fake.js";

const KEY = seed(61);
const CODE = bytes("pinned anchor runtime code");
const ADDRESS = "0x92aa49faf844dee74ab85de1a42a0705e8ea8b08";
const listed = (name: string, id: bigint, cls: ListedChain["classes"][number]["class"]): ListedChain => ({ name, chain: `eip155:${id}`, chainId: id, genesisHash: keccakHex(bytes(`genesis ${id}`)), classes: [{ from: 0, class: cls }] });
const OPERATOR = listed("Devnet A", 31337n, "operator"); // attested
const CONSORTIUM = listed("Devnet C", 31339n, "consortium"); // attested
const CONSENSUS = listed("Devnet B", 31338n, "consensus"); // proven
const PIN: EvmAnchorPin = { address: ADDRESS, codeHash: keccakHex(CODE), chains: [...EVM_CHAINS, OPERATOR, CONSENSUS, CONSORTIUM] };
const MINTER = "0x" + "a1".repeat(20);
const CAROL = "0x" + "c3".repeat(20);
const MALLORY = "0x" + "e5".repeat(20);
const V1 = bytes("# Harbor at dusk\n");
const V2 = bytes(`# Harbor at night\n${"~".repeat(100)}\n`);

const devnet = (l: ListedChain): FakeChain => ({ chainId: l.chainId, genesisHash: l.genesisHash, finalized: 1, latest: 1, code: CODE, address: ADDRESS, owners: new Map(), records: new Map() });

async function rejects(p: Promise<unknown>, code: string, category?: string): Promise<OriginalsError> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).code, (error as Error).message).toBe(code);
  if (category) expect((error as OriginalsError).category).toBe(category);
  return error as OriginalsError;
}

/** An author, three devnets and an SDK configured with providers for each (two for A). */
async function setup(options: { providers?: boolean; evm?: boolean; store?: OriginalsStore; alice?: Author; chains?: { A: FakeChain; B: FakeChain; C: FakeChain } } = {}) {
  const alice = options.alice ?? (await Author.create([{ fragment: "orig", secret: KEY }]));
  const { A, B, C } = options.chains ?? { A: devnet(OPERATOR), B: devnet(CONSENSUS), C: devnet(CONSORTIUM) };
  const calls: Call[] = [];
  const fetch = fakeNetwork({ "http://a-1": fakeProvider(A, calls), "http://a-2": fakeProvider(A), "http://b-1": fakeProvider(B), "http://c-1": fakeProvider(C) });
  const evm: OriginalsEvmOptions = {
    pin: PIN, fetch, pollMs: 0, sleep: () => Promise.resolve(),
    ...(options.providers === false ? {} : { providers: { [OPERATOR.chain]: ["http://a-1", { url: "http://a-2", name: "a-2" }], [CONSENSUS.chain]: ["http://b-1"], [CONSORTIUM.chain]: ["http://c-1"] } }),
  };
  const store = options.store ?? new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: () => Promise.resolve(alice.evidence()), clock: clock(), ...(options.evm === false ? {} : { evm }) });
  const signer = alice.signer("orig", KEY);
  const author = alice.ref("orig");
  return { alice, A, B, C, calls, fetch, evm, store, sdk, signer, author };
}
type Env = Awaited<ReturnType<typeof setup>>;

/** An Original anchored at genesis on Devnet A, minter MINTER, with the anchoring entry committed. */
async function anchored(env: Env, resource = V1) {
  const anchor: EvmAnchor = { chain: OPERATOR.chain, minter: MINTER };
  const c = await env.sdk.create({ name: "Harbor at dusk", resource: { mediaType: "text/markdown", bytes: resource }, author: env.author, signer: env.signer, anchor, acknowledged: evmGenesisNotice(anchor, PIN) });
  if (c.kind !== "original") throw new Error("expected an Original");
  const did = c.original.did;
  const a = await env.sdk.anchor(did, { parent: c.original.checkpoint, author: env.author, signer: env.signer });
  return { did, anchor, genesis: c.original.checkpoint, anchoring: a.original.checkpoint, alias: derivedTokenAlias(did, anchor, PIN) };
}

/** Prepare, acknowledge and submit the next publication, then make it final. */
async function publish(env: Env, did: string, wallet: ReturnType<typeof fakeWallet>, chain: FakeChain, extra: { maxTxBytes?: number } = {}) {
  const plan = await env.sdk.prepareEvmPublication(did, { wallet, ...extra });
  const submitted = await env.sdk.submitEvmPublication(did, plan, { wallet, acknowledged: plan.notice });
  finalize(chain);
  return { plan, submitted };
}

/** Anchored on Devnet A and published there, final. */
async function published(env: Env) {
  const o = await anchored(env);
  const wallet = fakeWallet(env.A, MINTER);
  await env.sdk.mintEvm(o.did, { wallet });
  await publish(env, o.did, wallet, env.A);
  return { ...o, wallet };
}

describe("create with an EVM anchor (P9.19, P9.27, section 14)", () => {
  test("C12-278: 'Writer creating an Original with an EVM `anchor`': nothing is written until the author acknowledged the P9.27 notice for exactly that anchor", async () => {
    const env = await setup();
    const anchor = { chain: OPERATOR.chain, minter: MINTER };
    const input = { name: "Harbor", resource: { mediaType: "text/markdown", bytes: V1 }, author: env.author, signer: env.signer, anchor };
    await rejects(env.sdk.create(input), "EVM_NOTICE_REQUIRED", "invalid-evidence");
    await rejects(env.sdk.create({ ...input, acknowledged: evmGenesisNotice({ chain: OPERATOR.chain, minter: CAROL }, PIN) }), "EVM_NOTICE_REQUIRED");
    await rejects(env.sdk.create({ ...input, acknowledged: evmGenesisNotice({ chain: CONSENSUS.chain, minter: MINTER }, PIN) }), "EVM_NOTICE_REQUIRED");
    expect(await env.store.list()).toEqual([]);
    const notice = evmGenesisNotice(anchor, PIN);
    expect(notice.text).toContain(MINTER);
    expect(notice.chain).toMatchObject({ trustClass: "operator", layer: "attested" });
    const c = await env.sdk.create({ ...input, acknowledged: notice });
    if (c.kind !== "original") throw new Error("expected an Original");
    expect(c.original.state.anchor).toEqual(anchor);
    // P9.23, C12-331: the genesis anchor member alone is not anchored; never current.
    const view = await env.sdk.get(c.original.did);
    expect(view.report.evm?.status).toBe("not-anchored");
    expect(view.current).toBe(false);
  });

  test("C12-239: 'Genesis entry with an anchor member while P14.21 pins no contract': without the experimental pin no anchor member is written, and a stored one is unsupported", async () => {
    const env = await setup();
    const o = await anchored(env);
    const bare = await setup({ evm: false, store: env.store, alice: env.alice });
    const anchor = { chain: OPERATOR.chain, minter: MINTER };
    await rejects(bare.sdk.create({ name: "Harbor", resource: { mediaType: "text/markdown", bytes: V1 }, author: env.author, signer: env.signer, anchor, acknowledged: evmGenesisNotice(anchor, PIN) }), "EVM_NO_ANCHOR_CONTRACT", "unsupported-profile");
    const err = await rejects(bare.sdk.get(o.did), "ORIGINAL_NOT_VERIFIED");
    expect((err.details as { report: { evm: { status: string } } }).report.evm.status).toBe("unsupported");
  });
});

describe("anchoring on the token (P9.19, P9.18 through P9.20, P9.27)", () => {
  test("C12-331: 'Signed anchoring entry not published': anchor() lists the derived token alias, never a sat; the Original is not anchored until the publication is final", async () => {
    const env = await setup();
    const o = await anchored(env);
    const committed = await env.sdk.committedLog(o.did);
    const last = parseJson(committed.trimEnd().split("\n").pop()!) as { state: { asset: { aliases: string[] } } };
    expect(last.state.asset.aliases).toEqual([o.alias]);
    await rejects(env.sdk.anchor(o.did, { parent: o.anchoring, author: env.author, signer: env.signer }), "ALREADY_ANCHORED");
    await rejects(env.sdk.anchor(o.did, { parent: o.anchoring, author: env.author, signer: env.signer, sat: "did:btco:reg:5000000000" }), "ANCHOR_IS_EVM");
    const view = await env.sdk.get(o.did);
    expect(view.report.evm?.status).toBe("not-anchored");
    expect(view.checkpoint).toBe(o.genesis);
    expect(view.current).toBe(false);
  });

  test("C12-329: 'Writer staging an upload': mint, publish, label, verify; then one entry per publication, by publishSameBody and in stages (P9.17, P9.25, P14.20)", async () => {
    const env = await setup();
    const o = await anchored(env);
    // P14.19: only the minter's wallet mints the Original's token.
    await rejects(env.sdk.mintEvm(o.did, { wallet: fakeWallet(env.A, MALLORY) }), "EVM_WRONG_MINTER");
    const wallet = fakeWallet(env.A, MINTER);
    const minted = await env.sdk.mintEvm(o.did, { wallet });
    expect(minted.alias).toBe(o.alias);

    const plan = await env.sdk.prepareEvmPublication(o.did, { wallet });
    expect(plan).toMatchObject({ kind: "anchoring", alias: o.alias, chain: OPERATOR.chain, versionId: o.anchoring, carries: [o.genesis, o.anchoring], remaining: 0 });
    expect(plan.prepared.plan).toEqual({ kind: "publish" });
    expect(plan.notice.text).toContain("public");
    // P9.18: nothing is sent until the author acknowledged what becomes public and permanent.
    await rejects(env.sdk.submitEvmPublication(o.did, plan, { wallet } as never), "EVM_NOTICE_REQUIRED");
    const submitted = await env.sdk.submitEvmPublication(o.did, plan, { wallet, acknowledged: plan.notice });
    expect(submitted).toMatchObject({ index: 0, status: "pending-evm-finality", versionId: o.anchoring });

    // P9.22, P9.27: recorded above the finalized block, it is observed, never accepted, and nothing else is prepared.
    const pending = await env.sdk.get(o.did);
    expect(pending.report.evm?.status).toBe("not-anchored");
    expect(pending.report.evm?.stretches[0]?.observed.map((r) => r.index)).toEqual([0]);
    await rejects(env.sdk.prepareEvmPublication(o.did, { wallet }), "EVM_PUBLICATION_PENDING", "incomplete-evidence");

    finalize(env.A);
    const state = await env.sdk.evmPublicationStatus(o.did, submitted);
    expect(state.status).toBe("finalized");
    const r = state.original!.report;
    expect(r.evm?.status).toBe("anchored");
    expect(r.head).toBe(o.anchoring);
    expect(r.ordering).toBe("evm-attested-by-operator");
    expect(r.evm?.owner).toMatchObject({ address: MINTER, chain: OPERATOR.chain, class: "operator" });
    expect(r.evm?.stretches[0]?.providers).toEqual(["http://a-1", "a-2"]);
    expect(state.original!.current, JSON.stringify(r.reasons)).toBe(true);

    // C12-28 through P9.20: an entry committed after anchoring is the local log, not current, until published.
    const renamed = await env.sdk.edit(o.did, { parent: o.anchoring, name: "Harbor at night", author: env.author, signer: env.signer });
    expect(renamed.original.current).toBe(false);
    expect(renamed.original.report.reasons).toContain("evm-evidence-missing");
    expect((await env.sdk.get(o.did)).head).toBe(o.anchoring);
    const p1 = await env.sdk.prepareEvmPublication(o.did, { wallet });
    expect(p1).toMatchObject({ kind: "entry", carries: [renamed.original.checkpoint] });
    // P14.20 SHOULD: the body is already on the token.
    expect(p1.prepared.plan).toEqual({ kind: "publishSameBody" });
    await env.sdk.submitEvmPublication(o.did, p1, { wallet, acknowledged: p1.notice });
    finalize(env.A);
    expect((await env.sdk.get(o.did)).head).toBe(renamed.original.checkpoint);

    // A new version over the transaction budget: staged; the upload ID comes from UploadBegun, and the record
    // is read from state (the event is never evidence).
    const v2 = await env.sdk.edit(o.did, { parent: renamed.original.checkpoint, resource: { bytes: V2 }, author: env.author, signer: env.signer });
    wallet.sent.length = 0;
    const { plan: p2 } = await publish(env, o.did, wallet, env.A, { maxTxBytes: 64 });
    expect(p2.prepared.plan).toMatchObject({ kind: "staged", commit: "commit" });
    expect(wallet.sent[0]).toBe("begin");
    expect(wallet.sent.at(-1)).toBe("commit");
    const view = await env.sdk.get(o.did);
    expect(view.head).toBe(v2.original.checkpoint);
    expect(view.current).toBe(true);
    expect(view.resources.find((v) => v.versionId === v2.original.checkpoint)?.bytes).toBe("verified");
    await rejects(env.sdk.prepareEvmPublication(o.did, { wallet }), "NOTHING_TO_PUBLISH");
  });

  test("P9.18 through P9.20: the log through the anchoring entry, with its signer's identity evidence, must verify before it is published", async () => {
    const env = await setup();
    const o = await anchored(env);
    const wallet = fakeWallet(env.A, MINTER);
    await env.sdk.mintEvm(o.did, { wallet });
    // The author DID drops the key that signed the anchoring entry: it is historically authorized only (P7.9).
    await env.alice.rotate([{ fragment: "next", secret: seed(62) }]);
    const err = await rejects(env.sdk.prepareEvmPublication(o.did, { wallet }), "EVM_ANCHORING_NOT_VERIFIED");
    expect(wallet.sent).toEqual(["mint"]);
    expect((err.details as { problems: string[] }).problems.length).toBeGreaterThan(0);
  });

  test("an Original without an anchor member is published with the Bitcoin writer, and no token is minted for it", async () => {
    const env = await setup();
    const c = await env.sdk.create({ name: "Plain", resource: { mediaType: "text/markdown", bytes: V1 }, author: env.author, signer: env.signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    await rejects(env.sdk.prepareEvmPublication(c.original.did, { wallet: fakeWallet(env.A, MINTER) }), "NOT_EVM_ANCHORED");
    await rejects(env.sdk.mintEvm(c.original.did, { wallet: fakeWallet(env.A, MINTER) }), "NOT_EVM_ANCHORED");
  });
});

describe("verifying from the tokens (P9.20-P9.25)", () => {
  test("C12-328: 'Token with many records, verifier holding a checkpoint': the store keeps the finalized blocks and checkpoints, and the next read resumes from the checkpoint", async () => {
    const env = await setup();
    const o = await published(env);
    const v = await env.sdk.edit(o.did, { parent: o.anchoring, name: "Harbor, later", author: env.author, signer: env.signer });
    await publish(env, o.did, o.wallet, env.A);
    await env.sdk.get(o.did);
    const kept = await env.store.getRetainedEvm!(o.did);
    expect(kept?.blocks).toEqual([{ chain: OPERATOR.chain, number: env.A.finalized, hash: expect.any(String) as string }]);
    expect(kept?.checkpoints[0]).toMatchObject({ token: o.alias, records: 2, head: v.original.checkpoint });
    env.calls.length = 0;
    const again = await env.sdk.get(o.did);
    expect(again.head).toBe(v.original.checkpoint);
    expect(again.current, JSON.stringify(again.report.reasons)).toBe(true);
    expect(again.report.evm?.stretches[0]?.resumedFrom?.records).toBe(2);
    // Only records from the checkpoint on are read (P9.25).
    const read = env.calls.filter((c) => c.name === "publication" || c.name === "metadata").map((c) => Number(c.args![1]));
    expect(read.every((i) => i >= 2)).toBe(true);
  });

  test("the caller's own reads are used as given; without them or providers, the committed log is unverified on the chain and never current", async () => {
    const env = await setup();
    const o = await published(env);
    const offline = await setup({ providers: false, store: env.store, alice: env.alice });
    const local = await offline.sdk.get(o.did);
    expect(local.head).toBe(o.anchoring);
    expect(local.report.evm?.status).toBe("unverified");
    expect(local.current).toBe(false);
    const { evidence } = await readEvmToken({ alias: o.alias }, { pin: PIN, providers: ["http://a-1"], fetch: env.fetch });
    const supplied = await offline.sdk.get(o.did, { evm: [evidence] });
    expect(supplied.report.evm?.status).toBe("anchored");
    expect(supplied.current).toBe(true);
  });

  test("FileStore keeps the retained EVM blocks and checkpoints across handles, and ignores a malformed record", async () => {
    const root = mkdtempSync(join(tmpdir(), "originals-evm-"));
    try {
      const store = await FileStore.open(root);
      const env = await setup({ store });
      const o = await published(env);
      await env.sdk.get(o.did);
      const kept = await store.getRetainedEvm(o.did);
      expect(kept?.checkpoints[0]).toMatchObject({ token: o.alias, records: 1 });
      await store.close();
      const reopened = await FileStore.open(root);
      expect(await reopened.getRetainedEvm(o.did)).toEqual(kept!);
      const file = readdirSync(join(root, "evm"))[0]!;
      writeFileSync(join(root, "evm", file), JSON.stringify({ did: o.did, blocks: [{ chain: 1 }], checkpoints: [{}] }));
      expect(await reopened.getRetainedEvm(o.did)).toEqual({ blocks: [], checkpoints: [] });
      await reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P9.12, P9.13: commits after anchoring", () => {
  test("C12-30 through P9.20: a token that accepted another branch's entry stops commits on the local branch; nothing is rebased", async () => {
    const env = await setup();
    const o = await published(env);
    // The holder publishes an author-signed entry the local log does not hold.
    const head = parseJson((await env.sdk.committedLog(o.did)).trimEnd().split("\n").pop()!) as unknown as LogEntry;
    const sign = signWith(localSigner("Ed25519", KEY), { cryptosuite: "eddsa-jcs-2022", verificationMethod: env.author.verificationMethod });
    const other = await updateOriginal(head, { versionTime: new Date(Date.parse(head.versionTime) + 1).toISOString(), author: env.author, sign, name: "Another branch", evm: PIN });
    const ctx = { chain: OPERATOR.chain, pin: PIN, wallet: o.wallet, rpc: "http://a-1", fetch: env.fetch, pollMs: 0, sleep: () => Promise.resolve() };
    await submitPublication(ctx, await preparePublication(ctx, { alias: o.alias, lines: [JSON.stringify(other)], body: V1 }));
    finalize(env.A);
    const seen = await env.sdk.get(o.did);
    expect(seen.head, JSON.stringify(seen.report.evm?.stretches[0]?.ignored)).toBe(other.versionId);
    await rejects(env.sdk.edit(o.did, { parent: o.anchoring, name: "Local", author: env.author, signer: env.signer }), "EVM_HEAD_NOT_STORED", "stale-parent");
    await rejects(env.sdk.prepareEvmPublication(o.did, { wallet: o.wallet }), "EVM_HEAD_NOT_STORED");
  });
});

describe("moves (P9.28, P9.29)", () => {
  test("C12-276, C12-270: 'Report for an Original that moved from an attested chain to a proven chain': departure on the token left, arrival on the destination minted by its minter", async () => {
    const env = await setup();
    const o = await published(env);
    // P9.28: never sideways or down.
    await rejects(env.sdk.prepareMove(o.did, { parent: o.anchoring, author: env.author, to: { chain: CONSORTIUM.chain, minter: CAROL } }), "STATE_MOVE_LAYER");
    const to = { chain: CONSENSUS.chain, minter: CAROL };
    // Only the author prepares a move entry (P9.28).
    await rejects(env.sdk.prepareMove(o.did, { parent: o.anchoring, author: env.author, to, editor: env.author } as never), "INPUT_INVALID");
    const prepared = await env.sdk.prepareMove(o.did, { parent: o.anchoring, author: env.author, to });
    const { notice, draft } = prepared;
    expect(notice).toMatchObject({ kind: "evm-move", irreversible: true, layersAbove: ["bitcoin"] });
    expect((draft.entry.state as unknown as { asset: { anchor: unknown; aliases: string[] } }).asset).toMatchObject({ anchor: to, aliases: [derivedTokenAlias(o.did, to, PIN)] });
    await rejects(env.sdk.move(o.did, { prepared, signer: env.signer } as never), "EVM_NOTICE_REQUIRED");
    // The notice of another move is not this one's.
    const other = await env.sdk.prepareMove(o.did, { parent: o.anchoring, author: env.author, to: { sat: "did:btco:reg:5000000000" } });
    await rejects(env.sdk.move(o.did, { prepared, signer: env.signer, acknowledged: other.notice }), "EVM_NOTICE_REQUIRED");
    const moved = await env.sdk.move(o.did, { prepared, signer: env.signer, acknowledged: notice });

    // Minted by the destination's minter (P14.19).
    await rejects(env.sdk.mintEvm(o.did, { wallet: fakeWallet(env.B, MINTER) }), "EVM_WRONG_MINTER");
    const carol = fakeWallet(env.B, CAROL);
    await env.sdk.mintEvm(o.did, { wallet: carol });

    const { plan: departure } = await publish(env, o.did, o.wallet, env.A);
    expect(departure).toMatchObject({ kind: "departure", alias: o.alias, carries: [moved.original.checkpoint] });
    const between = await env.sdk.get(o.did);
    expect(between.report.evm).toMatchObject({ status: "departed-not-arrived", owner: null });
    expect(between.current).toBe(false);

    const { plan: arrival } = await publish(env, o.did, carol, env.B);
    expect(arrival).toMatchObject({ kind: "arrival", alias: derivedTokenAlias(o.did, to, PIN), carries: [o.genesis, o.anchoring, moved.original.checkpoint] });
    const view = await env.sdk.get(o.did);
    expect(view.report.evm).toMatchObject({ status: "anchored", move: "confirmed", arrival: "arrived" });
    expect(view.report.evm?.stretches.map((st) => [st.chain, st.class])).toEqual([[OPERATOR.chain, "operator"], [CONSENSUS.chain, "consensus"]]);
    expect(view.report.evm?.owner).toMatchObject({ address: CAROL, chain: CONSENSUS.chain, describes: "proven" });
    expect(view.current, JSON.stringify(view.report.reasons)).toBe(true);

    // Later entries go on the destination token; a move back down is refused (P9.28).
    await rejects(env.sdk.prepareMove(o.did, { parent: moved.original.checkpoint, author: env.author, to: { chain: OPERATOR.chain, minter: MINTER } }), "STATE_MOVE_LAYER");
    await env.sdk.edit(o.did, { parent: moved.original.checkpoint, name: "Harbor, moved", author: env.author, signer: env.signer });
    const { plan: later } = await publish(env, o.did, carol, env.B);
    expect(later).toMatchObject({ kind: "entry", alias: derivedTokenAlias(o.did, to, PIN) });
  });

  test("C12-277: 'Writer moving an Original': refused before anything is signed when the arrival would exceed 350,000 bytes, and before the token alias is listed", async () => {
    const env = await setup();
    const anchor = { chain: OPERATOR.chain, minter: MINTER };
    const big = new Uint8Array(340_000).fill(0x61);
    const c = await env.sdk.create({ name: "Big", resource: { mediaType: "text/markdown", bytes: big }, author: env.author, signer: env.signer, anchor, acknowledged: evmGenesisNotice(anchor, PIN) });
    if (c.kind !== "original") throw new Error("expected an Original");
    const to = { chain: CONSENSUS.chain, minter: CAROL };
    await rejects(env.sdk.prepareMove(c.original.did, { parent: c.original.checkpoint, author: env.author, to }), "STATE_MOVE_BEFORE_ANCHOR");
    const a = await env.sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: env.author, signer: env.signer });
    const e = await env.sdk.edit(c.original.did, { parent: a.original.checkpoint, metadata: { notes: "n".repeat(9_000) }, author: env.author, signer: env.signer });
    await rejects(env.sdk.prepareMove(c.original.did, { parent: e.original.checkpoint, author: env.author, to }), "MOVE_ARRIVAL_TOO_LARGE", "limit-exceeded");
  });

  test("a move to Bitcoin: departure on the token, then the arrival is the Bitcoin writer's anchoring inscription through the move entry (P9.28, P9.29)", async () => {
    const env = await setup();
    const o = await published(env);
    const SAT = "5000000000";
    const sat = `did:btco:reg:${SAT}`;
    const prepared = await env.sdk.prepareMove(o.did, { parent: o.anchoring, author: env.author, to: { sat } });
    expect(prepared.notice.to).toMatchObject({ layer: "bitcoin" });
    const moved = await env.sdk.move(o.did, { prepared, signer: env.signer, acknowledged: prepared.notice });
    expect(moved.original.state.anchor).toBeUndefined();
    expect(moved.original.state.aliases).toEqual([sat]);
    // The Bitcoin writer takes over the arrival: its next entry is the move entry, carried with the whole log, on the sat.
    const tip = { height: 20, hash: (20).toString(16).padStart(64, "0") };
    const read: SatSnapshot = { network: "regtest", sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [], publications: [], ownership: { owner: "bcrt1qholder", satpoint: `${"cc".repeat(32)}:0:0` } } as unknown as SatSnapshot;
    const provider = { getFirstSatOfOutput: () => Promise.resolve(SAT), getSatSnapshot: () => Promise.resolve(read), getTransactionStatus: () => Promise.resolve({ confirmed: true, confirmations: 3 }) } as unknown as OrdinalsProvider;
    const blocks = new InscriptionClock((h) => Promise.resolve({ time: 1_800_000_000 + h * 600, hash: h.toString(16).padStart(64, "0") }));
    const pending = await nextPendingEntry(env.sdk, o.did, { provider, clock: blocks, index: "ord-a" });
    expect(pending).toMatchObject({ next: moved.original.checkpoint, queue: [moved.original.checkpoint], sat });
    const satSigner: BitcoinSigner = { signAndFinalizeCommitPsbt: () => Promise.reject(new Error("not reached")) };
    const utxo = { txid: "ab".repeat(32), vout: 0, value: 100_000, scriptPubKey: "0014" + "11".repeat(20) };
    const inscribe = () => prepareEntryInscription({ sdk: env.sdk, did: o.did, fundingUtxos: [utxo], satSigner, changeAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", feeRate: 2, network: "regtest", provider, clock: blocks, index: "ord-a", recoveryStore: null });
    // P9.29: not before the departure is accepted and final on the token left.
    await rejects(inscribe(), "EVM_DEPARTURE_NOT_FINAL", "incomplete-evidence");
    const { plan } = await publish(env, o.did, o.wallet, env.A);
    expect(plan.kind).toBe("departure");
    const err = await rejects(env.sdk.prepareEvmPublication(o.did, { wallet: o.wallet }), "EVM_ARRIVAL_ON_BITCOIN");
    expect(err.details).toMatchObject({ versionId: moved.original.checkpoint, sat });
    // Then verified through the move entry (P9.18), and on to signing.
    await expect(inscribe()).rejects.toThrow("not reached");
  });
});

describe("carried files after EVM anchoring (P7.15)", () => {
  test("C12-291, C12-317: 'Writer making a carried file from an accepted publication's body and entries': allowed; a later entry not accepted on the token is refused; a pre-anchor checkpoint is historical", async () => {
    const env = await setup();
    const o = await published(env);
    const disclosure = await env.sdk.carriedDisclosure(o.did, { checkpoint: o.anchoring });
    const file = await env.sdk.carry(o.did, { checkpoint: o.anchoring, disclosed: disclosure });
    expect(file).toMatchObject({ checkpoint: o.anchoring, mediaType: "text/markdown" });
    const genesis = await env.sdk.carriedDisclosure(o.did, { checkpoint: o.genesis });
    expect(genesis.checkpoint).toBe(o.genesis);
    await env.sdk.edit(o.did, { parent: o.anchoring, name: "Unpublished", author: env.author, signer: env.signer });
    await rejects(env.sdk.carriedDisclosure(o.did), "CARRIER_NOT_ACCEPTED");
    // Without a read of the token, nothing from the anchoring entry on is accepted.
    const offline = await setup({ providers: false, store: env.store, alice: env.alice });
    await rejects(offline.sdk.carriedDisclosure(o.did, { checkpoint: o.anchoring }), "CARRIER_NOT_ACCEPTED");
  });
});
