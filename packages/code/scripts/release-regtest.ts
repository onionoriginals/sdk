/**
 * Anchoring a release Original (plan 049 §6, K15) on DISPOSABLE REGTEST ONLY:
 * Bitcoin Core 31.1 and ord 0.29.0 in a temporary directory, started and
 * stopped here (the repo's `scripts/regtest` harness). Nothing touches
 * mainnet or testnet.
 *
 *  1. Mirror a fixture git repository, release v1 (the release Original is
 *     created and named in the repo document).
 *  2. Anchor the release Original with the SDK's own flow: `sdk.anchor`,
 *     `prepareEntryInscription`, `submitEntryInscription`, mine, and
 *     `readAnchored`: anchored and current (P9.4, P9.11, P9.16).
 *  3. Release v2 (an ordinary edit) and reinscribe it on the same sat by
 *     spending the output that holds it (P9.12, P9.13): current again.
 *  4. The repo bundle verifies offline: the release history is valid and each
 *     release's commit is in the named branch chain. The release Original's
 *     own Originals report is passed through as the SDK gives it; branch
 *     Originals stay unanchored (owner decision 2026-11-19).
 *
 *   bun scripts/release-regtest.ts       (uses BITCOIND_BIN/ORD_BIN, or the pinned installer's cache)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { RegtestProvider } from "@originals/sdk";
import { InscriptionClock, MemoryStore, btcoAlias, keySigner } from "@originals/sdk/originals";
import { prepareEntryInscription, readAnchored, submitEntryInscription } from "@originals/sdk/originals/bitcoin";
import { startRegtest } from "../../../scripts/regtest/environment";
import { installRegtestTools } from "../../../scripts/regtest/install";
import { GitSource } from "../src/git.js";
import { CodeWorkspace, MemoryObjectStore, SIGNING_FRAGMENT, createLocalIdentity, identityRef, verifyRepository } from "../src/index.js";

const ORD = "ord-0.29.0-regtest";
const step = (s: string) => console.error(`[code-release-regtest] ${s}`);
if (!process.env.BITCOIND_BIN || !process.env.ORD_BIN) Object.assign(process.env, await installRegtestTools());

const dir = mkdtempSync(join(tmpdir(), "originals-code-release-"));
const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const commit = (file: string, text: string) => {
  execFileSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", text, join(dir, file)]);
  git("add", "-A");
  git("commit", "-q", "-m", `${file}: ${text}`);
  return git("rev-parse", "HEAD");
};

step("starting Bitcoin Core and ord (regtest)");
const env = await startRegtest({ indexAddresses: true });
const evidence: Record<string, unknown> = { versions: env.versions, network: "regtest" };
const source = () => new GitSource(dir);
try {
  const provider = new RegtestProvider(env);
  const walletKey = secp256k1.utils.randomSecretKey();
  const wallet = btc.p2wpkh(secp256k1.getPublicKey(walletKey, true), { ...btc.TEST_NETWORK, bech32: "bcrt" });
  const satSigner = {
    signAndFinalizeCommitPsbt(psbtBase64: string) {
      const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, "base64"), { allowUnknownOutputs: true });
      tx.sign(walletKey);
      tx.finalize();
      return Promise.resolve(tx.hex);
    },
  };
  const outputOf = async (txid: string, vout?: number) => {
    const tx = await env.rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { address?: string; hex: string } }> }>("getrawtransaction", [txid, true]);
    const output = vout === undefined ? tx.vout.find((o) => o.scriptPubKey.address === wallet.address) : tx.vout[vout];
    assert.ok(output, `no wallet output in ${txid}`);
    return { txid, vout: output.n, value: Math.round(output.value * 100_000_000), scriptPubKey: output.scriptPubKey.hex };
  };
  const fundUtxo = async (amount = 0.01) => outputOf(await env.fund(wallet.address!, amount));
  // Commit/reveal recovery records (in memory: a disposable chain, one process).
  const records = new Map<string, unknown>();
  const recoveryStore = {
    save: (r: { recoveryId: string }) => Promise.resolve(void records.set(r.recoveryId, structuredClone(r))),
    load: (id: string) => Promise.resolve(structuredClone(records.get(id))),
    list: () => Promise.resolve([...records.keys()]),
  } as never;
  const clock = new InscriptionClock(async (height: number) => {
    const hash = await env.rpc<string>("getblockhash", [height]);
    const header = await env.rpc<{ time: number; previousblockhash?: string }>("getblockheader", [hash]);
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  });

  step("1: mirror and release v1");
  git("init", "-q", "-b", "main");
  const commits = [commit("a.txt", "1"), commit("a.txt", "2")];
  const alice = await createLocalIdentity({ now: Date.now() - 3_600_000 });
  const ws = CodeWorkspace.create({ originals: new MemoryStore(), objects: new MemoryObjectStore(), identities: [alice] });
  const repo = await ws.initRepo({ name: "release-regtest", identity: alice });
  let s = source();
  await ws.mirror({ repo, ref: "refs/heads/main", identity: alice, source: s });
  s.close();
  const v1 = await ws.release(repo, alice, { tag: "v1.0.0" });
  assert.equal(v1.manifest.commit, commits[1]);
  const releases = v1.releases;

  step("2: anchor the release Original");
  const sdk = ws.sdk;
  const author = identityRef(alice);
  const signer = keySigner({ keyType: "Ed25519", secretKey: alice.signingSecret, verificationMethod: `${alice.did}#${SIGNING_FRAGMENT}` });
  const satUtxo = await fundUtxo(0.001);
  const sat = btcoAlias("regtest", await provider.getFirstSatOfOutput!(satUtxo));
  const anchored = await sdk.anchor(releases, { parent: v1.versionId, author, signer, sat });
  const anchorPair = await prepareEntryInscription({ sdk, did: releases, fundingUtxos: [satUtxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider, clock, index: ORD, recoveryStore });
  assert.equal(anchorPair.versionId, anchored.original.checkpoint);
  assert.equal(anchorPair.notice.permanent, true);
  const sent = await submitEntryInscription({ sdk, did: releases, pair: anchorPair, provider, clock, index: ORD, recoveryStore });
  assert.equal(sent.broadcast, "reveal_broadcast");
  const pending = await readAnchored(sdk, releases, { provider, clock, index: ORD, recoveryStore, recoveryIds: [...records.keys()] });
  assert.equal(pending.current, false, "broadcast and unmined does not count (P9.4)");
  await env.mine();
  const a1 = await readAnchored(sdk, releases, { provider, clock, index: ORD, recoveryStore, recoveryIds: [...records.keys()] });
  assert.equal(a1.report.anchoring?.status, "anchored");
  assert.equal(a1.current, true, JSON.stringify(a1.report.reasons));
  evidence.anchor = { releases, sat, commitTxId: anchorPair.prepared.commitTxId, revealTxId: anchorPair.prepared.revealTxId, inscription: anchorPair.prepared.inscriptionId, carries: anchorPair.carries, current: a1.current, ownership: a1.report.ownership };

  step("3: release v2 and reinscribe on the same sat");
  commits.push(commit("a.txt", "3"));
  s = source();
  await ws.mirror({ repo, ref: "refs/heads/main", identity: alice, source: s });
  s.close();
  const v2 = await ws.release(repo, alice, { tag: "v1.1.0" });
  assert.equal(v2.manifest.commit, commits[2]);
  const editPair = await prepareEntryInscription({ sdk, did: releases, fundingUtxos: [await outputOf(anchorPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider, clock, index: ORD, recoveryStore });
  assert.deepEqual(editPair.carries, [v2.versionId]);
  assert.equal((await submitEntryInscription({ sdk, did: releases, pair: editPair, provider, clock, index: ORD, recoveryStore })).broadcast, "reveal_broadcast");
  await env.mine();
  const a2 = await readAnchored(sdk, releases, { provider, clock, index: ORD, recoveryStore, recoveryIds: [...records.keys()] });
  assert.equal(a2.head, v2.versionId);
  assert.equal(a2.current, true, JSON.stringify(a2.report.reasons));
  evidence.reinscribe = { inscription: editPair.prepared.inscriptionId, head: a2.head, current: a2.current };

  step("4: the bundle verifies offline");
  const report = await verifyRepository(await ws.package(repo));
  const rel = report.releases!;
  assert.equal(rel.code?.history.status, "valid", JSON.stringify(rel.code?.history));
  assert.deepEqual(rel.code?.releases.map((r) => [r.tag, r.commit, r.chain]), [
    ["v1.0.0", commits[1], "in-chain"],
    ["v1.1.0", commits[2], "in-chain"],
  ]);
  assert.equal(report.canonical[0].head?.commit, commits[2]);
  evidence.offline = { releasesHistory: rel.report?.history.status, releasesAnchoring: rel.report?.anchoring?.status ?? null, code: rel.code?.history.status, releases: rel.code?.releases.length, canonical: report.canonical[0].status, branchesCurrent: report.current };
  evidence.result = "passed";
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await env.stop();
  rmSync(dir, { recursive: true, force: true });
}
