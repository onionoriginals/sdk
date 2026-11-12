/**
 * EVM anchoring end to end on a disposable anvil chain (originals-spec PR 59,
 * EXPERIMENTAL). The anchor contract from `contracts/` is deployed through
 * the deterministic deployment proxy with a zero salt (P14.21), an Original
 * is created with an `anchor` member on the devnet (added to an experimental
 * pin's chains), its token is minted (P14.19), and entries are published:
 * the anchoring publication in one transaction, a 100 kB version in stages
 * (`begin`/`append`/`commit`), a 30,000-byte entry that keeps the resource in
 * stages on a 24,000-byte transaction budget (`commitSameBody`), and a small
 * one by `publishSameBody` (P14.20). The reader then reads the evidence at
 * the finalized block (P9.21, P9.22, P9.25).
 *
 * Gated like the regtest journeys, on local tooling: the package's `test`
 * script includes this file, but it skips unless `anvil` is found (on the
 * PATH or in ~/.foundry/bin) and the contract is built or `forge` can build
 * it, and it always skips when ORIGINALS_EVM_ANVIL=0. CI has no anvil. Local
 * chains only: nothing here talks to a public network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { localSigner } from "@originals/vh/crypto";
import { serializeLog, signWith, type LogEntry } from "@originals/vh/log";
import {
  EVM_CHAINS,
  createOriginal,
  derivedTokenAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type EvmAnchorPin,
  type ListedChain,
} from "@originals/vh/originals";
import { keccakHex, toHex } from "../../src/originals/evm-abi.js";
import {
  EvmRpc,
  evmGenesisNotice,
  evmPublicationStatus,
  mintEvmToken,
  prepareEvmPublication,
  readEvmToken,
  submitEvmPublication,
  waitForEvmReceipt,
  type EvmFetch,
  type EvmWallet,
  type EvmWriterContext,
} from "../../src/originals/evm.js";
import { inscriptionMetadata } from "../../src/originals/inscription.js";
import { Author, seed } from "../unit/originals/helpers.js";

const ROOT = resolve(import.meta.dir, "../../../..");
const CONTRACTS = join(ROOT, "contracts");
const ARTIFACT = join(CONTRACTS, "out/OriginalsAnchor.sol/OriginalsAnchor.json");
const PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

function tool(name: string): string | null {
  const local = join(homedir(), ".foundry/bin", name);
  if (existsSync(local)) return local;
  const found = Bun.which(name);
  return found ?? null;
}

// The test preload replaces global fetch before each test; this file talks to a real local node,
// so it injects the real one (every adapter takes `fetch`).
const realFetch = globalThis.fetch.bind(globalThis) as unknown as EvmFetch;

const ANVIL = process.env.ORIGINALS_EVM_ANVIL === "0" ? null : tool("anvil");
const FORGE = tool("forge");
const enabled = ANVIL !== null && (existsSync(ARTIFACT) || FORGE !== null);

/** Anvil's unlocked dev accounts (its public, well-known test mnemonic): no key is handled here. */
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const MINTER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/** An injected wallet backed by anvil's unlocked accounts (`eth_sendTransaction`). */
const anvilWallet = (rpc: EvmRpc, address: string): EvmWallet => ({
  address,
  sendTransaction: (tx) => rpc.request<string>("eth_sendTransaction", [{ from: tx.from, to: tx.to, data: tx.data }]),
});

describe.skipIf(!enabled)("EVM anchoring on anvil (PR 59, experimental)", () => {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let url = "";
  let rpc: EvmRpc;
  let pin: EvmAnchorPin;
  const gas: Record<string, bigint> = {};

  beforeAll(async () => {
    if (!existsSync(ARTIFACT)) {
      const build = Bun.spawnSync([FORGE!, "build"], { cwd: CONTRACTS, stdout: "pipe", stderr: "pipe" });
      if (build.exitCode !== 0) throw new Error(`forge build failed: ${build.stderr.toString()}`);
    }
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    // Finalized trails latest by two blocks (anvil: 2 x slots per epoch), so pending is observable.
    proc = Bun.spawn([ANVIL!, "--port", String(port), "--slots-in-an-epoch", "1", "--silent"], { stdout: "ignore", stderr: "ignore" });
    url = `http://127.0.0.1:${port}`;
    rpc = new EvmRpc(url, { fetch: realFetch });
    for (let i = 0; ; i++) {
      try {
        await rpc.chainId();
        break;
      } catch (error) {
        if (i > 100) throw error;
        await Bun.sleep(100);
      }
    }
    // P14.21: CREATE2 through the deterministic deployment proxy, zero salt.
    const init = (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: string } }).bytecode.object;
    const deployed = await rpc.request<string>("eth_sendTransaction", [{ from: DEPLOYER, to: PROXY, data: `0x${"00".repeat(32)}${init.slice(2)}` }]);
    const receipt = await waitForEvmReceipt(rpc, deployed, { pollMs: 50 });
    gas.deploy = receipt.gasUsed;
    const address = "0x48f382c1d6c079bde4971c89e316841d2c9e79c2"; // contracts/README.md (build at PR 59 a3ffdc1)
    const code = await rpc.code(address, "latest");
    const genesis = (await rpc.block(0))!;
    const devnet: ListedChain = { name: "Anvil devnet", chain: "eip155:31337", chainId: 31337n, genesisHash: genesis.hash, classes: [{ from: 0, class: "operator" }] };
    pin = { address, codeHash: keccakHex(code), chains: [...EVM_CHAINS, devnet] };
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    if (Object.keys(gas).length) console.log("gasUsed on anvil:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, v.toString()])));
  });

  test("deployed at the README's CREATE2 address with the recorded runtime code hash (P14.21)", () => {
    expect(pin.codeHash).toBe("0x0a97a92302c38e4084f1d15ea5ff08fa8892f3161a54aa63e650f62a8f3f05f0");
  });

  test("create with anchor, mint, publish in one tx / in stages / by sameBody, read the finalized evidence", async () => {
    const KEY = seed(52);
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sign = signWith(localSigner("Ed25519", KEY), { cryptosuite: "eddsa-jcs-2022", verificationMethod: alice.ref("orig").verificationMethod });
    const author = alice.ref("orig");
    const v1 = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7) % 256);
    const v2 = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 13 + 5) % 256);
    const desc = (b: Uint8Array) => ({ mediaType: "image/png", size: b.length, digest: resourceDigest(b) });
    const anchor = { chain: "eip155:31337", minter: MINTER };

    // P9.27: the author is told what the anchor choice means before genesis is written.
    const notice = evmGenesisNotice(anchor, pin);
    expect(notice.chain).toMatchObject({ name: "Anvil devnet", trustClass: "operator", layer: "attested" });
    expect(notice.points[5]).toContain(MINTER);

    let t = Date.parse("2026-11-11T12:00:00Z");
    const at = () => new Date((t += 1_000)).toISOString().replace(".000Z", "Z");
    const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: desc(v1), author, sign, anchor, evm: pin });
    const did = genesis.state.id as string;
    const alias = derivedTokenAlias(did, anchor, pin);
    const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [alias], evm: pin });
    const edit = await updateOriginal(anchoring, { versionTime: at(), author, sign, resource: desc(v2), evm: pin });
    const bigMeta = await updateOriginal(edit, { versionTime: at(), author, sign, metadata: { notes: "n".repeat(29_000) }, evm: pin });
    const rename = await updateOriginal(bigMeta, { versionTime: at(), author, sign, name: "Harbor at night", evm: pin });
    const line = (...es: LogEntry[]) => serializeLog(es).split("\n").filter(Boolean);

    const ctx: EvmWriterContext = { chain: anchor.chain, pin, wallet: anvilWallet(rpc, MINTER), rpc: url, fetch: realFetch, pollMs: 50 };

    // P14.19: the minter mints the token derived from the Original.
    const minted = await mintEvmToken(ctx, { original: did, anchor });
    gas.mint = minted.gasUsed;
    expect(minted.alias).toBe(alias);
    expect(minted.owner).toBe(MINTER);
    expect((await mintEvmToken(ctx, { original: did, anchor })).txHash).toBeNull(); // already minted

    // 0: the anchoring publication, genesis through the anchoring entry, in one transaction.
    const p0 = await prepareEvmPublication(ctx, { alias, lines: line(genesis, anchoring), body: v1 });
    expect(p0.plan).toEqual({ kind: "publish" });
    const r0 = await submitEvmPublication(ctx, p0);
    gas["publish 20 kB anchoring"] = r0.gasUsed;
    expect(r0.index).toBe(0);

    // 1: a 100 kB version, over the default 60,000-byte transaction budget: staged.
    const p1 = await prepareEvmPublication(ctx, { alias, lines: line(edit), body: v2 });
    expect(p1.plan).toMatchObject({ kind: "staged", commit: "commit", appends: 2 });
    const r1 = await submitEvmPublication(ctx, p1);
    gas["staged 100 kB (begin+2 appends+commit)"] = r1.gasUsed;
    expect(r1.index).toBe(1);
    expect(r1.txHashes.length).toBe(4);

    // 2: C12-281: "Entry of 30,000 bytes that does not change the resource, on a chain that accepts
    // 24,000 bytes in one transaction": uploaded in stages and recorded by commitSameBody.
    const p2 = await prepareEvmPublication(ctx, { alias, lines: line(bigMeta), body: v2, maxTxBytes: 24_000 });
    expect(p2.metadata.length).toBeGreaterThan(24_000);
    expect(p2.plan).toEqual({ kind: "staged", appends: 2, commit: "commitSameBody" });
    expect(p2.sameBodyOf).toBe(1);
    const r2 = await submitEvmPublication(ctx, p2);
    gas["staged 30 kB entry, commitSameBody"] = r2.gasUsed;

    // 3: a small entry that keeps the resource: publishSameBody.
    const p3 = await prepareEvmPublication(ctx, { alias, lines: line(rename), body: v2 });
    expect(p3.plan).toEqual({ kind: "publishSameBody" });
    const r3 = await submitEvmPublication(ctx, p3);
    gas["publishSameBody"] = r3.gasUsed;
    expect(r3.index).toBe(3);

    // Just recorded, not yet finalized: pending (P9.27); then finalized.
    expect((await evmPublicationStatus(url, r3.txHashes, { fetch: realFetch })).status).toBe("pending-evm-finality");
    expect((await evmPublicationStatus(url, ["0x" + "00".repeat(32)], { fetch: realFetch })).status).toBe("submitted-unobserved");
    await rpc.request("anvil_mine", ["0x3"]);
    expect((await evmPublicationStatus(url, [...r0.txHashes, ...r1.txHashes, ...r3.txHashes], { fetch: realFetch })).status).toBe("finalized");

    // A fifth publication after that is observed, never accepted (P9.22).
    const later = await updateOriginal(rename, { versionTime: at(), author, sign, name: "Harbor, later", evm: pin });
    const r4 = await submitEvmPublication(ctx, await prepareEvmPublication(ctx, { alias, lines: line(later), body: v2 }));
    expect(r4.index).toBe(4);

    // Two provider names for the one node: both read at the common finalized block (P9.22).
    const { evidence, failures, commonBlock } = await readEvmToken({ original: did, anchor }, { pin, providers: [{ url, name: "anvil-a" }, { url, name: "anvil-b" }], observe: true, rangeBytes: 30_000, fetch: realFetch });
    expect(failures).toEqual([]);
    expect(evidence).toMatchObject({ chain: "eip155:31337", alias });
    expect(evidence.reads.length).toBe(2);
    const finalized = (await rpc.block("finalized"))!;
    expect(commonBlock).toBe(finalized.number);
    const expected = [
      { lines: line(genesis, anchoring), body: v1, bodyOf: 0 },
      { lines: line(edit), body: v2, bodyOf: 1 },
      { lines: line(bigMeta), body: v2, bodyOf: 1 },
      { lines: line(rename), body: v2, bodyOf: 1 },
    ];
    for (const read of evidence.reads) {
      expect(read.chainId).toBe(31337n);
      expect(read.genesisHash).toBe(pin.chains!.at(-1)!.genesisHash);
      expect(read.block).toEqual({ number: finalized.number, hash: finalized.hash });
      expect(read.codeHash).toBe(pin.codeHash);
      expect(read.owner).toBe(MINTER);
      expect(read.records!.length).toBe(4);
      read.records!.forEach((r, i) => {
        expect(r.index).toBe(i);
        expect(r.bodyOf).toBe(expected[i].bodyOf);
        expect(r.mediaType).toBe("image/png");
        expect(toHex(r.metadata!)).toBe(toHex(inscriptionMetadata(expected[i].lines)));
        expect(r.body!.length).toBe(expected[i].body.length);
        expect(resourceDigest(r.body!)).toBe(resourceDigest(expected[i].body));
        expect(r.timestamp).toBeGreaterThan(1_700_000_000);
      });
      expect(read.observed!.map((r) => r.index)).toEqual([4]);
    }
    // The vh verifier over the evidence the reader produced (P9.21-P9.27): anchored on the devnet,
    // attested by its operator, owned by MINTER, current as of the finalized block; record 4 observed only.
    const authors = [alice.evidence()];
    const report = await verifyOriginal({ authors, evm: { pin, tokens: [evidence] } });
    expect(report.history.status, JSON.stringify(report.history.failure)).toBe("valid");
    expect(report.evm?.status).toBe("anchored");
    expect(report.head).toBe(rename.versionId);
    expect(report.ordering).toBe("evm-attested-by-operator");
    expect(report.evm?.owner).toMatchObject({ address: MINTER, chain: "eip155:31337", class: "operator" });
    expect(report.evm?.stretches[0]?.block).toEqual({ number: finalized.number, hash: finalized.hash });
    expect(report.evm?.stretches[0]?.observed.map((o) => o.index)).toEqual([4]);
    expect(report.anchoring).toBeNull();
    expect(report.current, JSON.stringify(report.reasons)).toBe(true);
    // P9.22: the reader reports the hash of each block retained before; the same block passes.
    const again = await readEvmToken({ original: did, anchor }, { pin, providers: [{ url, name: "anvil-a" }], fetch: realFetch, retained: report.retain.evm });
    expect(again.evidence.reads[0]?.blockHashes).toEqual([{ number: finalized.number, hash: finalized.hash }]);
    const rereport = await verifyOriginal({ authors, evm: { pin, tokens: [again.evidence], retained: report.retain.evm } });
    expect(rereport.evm?.warnings).toEqual([]);
    expect(rereport.current).toBe(true);
    // P9.24 (a3ffdc1): on an operator chain, uniqueness is attested by the operator, under its finality and these providers.
    expect(report.evm?.stretches[0]?.uniqueness).toMatchObject({ status: "attested-by-operator", class: "operator", block: { number: finalized.number } });

    // PR59b: "Token with many records, verifier holding a checkpoint": once record 4 is final, the
    // reader resumes at the retained checkpoint's index and the verifier reads only that record (P9.25).
    const [checkpoint] = report.retain.evmCheckpoints ?? [];
    expect(checkpoint).toMatchObject({ token: alias, records: 4, head: rename.versionId });
    await rpc.request("anvil_mine", ["0x3"]);
    const resumed = await readEvmToken({ original: did, anchor }, { pin, providers: [{ url, name: "anvil-a" }, { url, name: "anvil-b" }], from: checkpoint!.records, fetch: realFetch });
    expect(resumed.failures).toEqual([]);
    expect(resumed.evidence.reads.map((r) => r.records!.map((x) => x.index))).toEqual([[4], [4]]);
    const log = [genesis, anchoring, edit, bigMeta, rename];
    const next = await verifyOriginal({ log, authors, evm: { pin, tokens: [resumed.evidence], checkpoints: [checkpoint!] } });
    expect(next.history.status, JSON.stringify(next.history.failure)).toBe("valid");
    expect(next.head).toBe(later.versionId);
    expect(next.evm?.stretches[0]?.resumedFrom).toEqual({ records: 4, block: checkpoint!.block });
    expect(next.current, JSON.stringify(next.reasons)).toBe(true);
  }, 180_000);
});
