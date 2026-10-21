/**
 * The Bitcoin writer across a real process kill (#975), on Bitcoin Core 31.1
 * and ord 0.29.0, regtest only. Nothing here touches mainnet or testnet.
 *
 * Every store is on disk in one temporary directory: the Original in a
 * `FileStore`, the writer's signed pairs in a `fileRecoveryStore`.
 *
 *  1. This process creates an Original, anchors it to a sat the disposable
 *     wallet holds and inscribes the anchoring entry; then edits it (new
 *     resource bytes). Broadcast but unmined, the anchor does not count (P9.4).
 *  2. A writer child process (`originals-writer-child.ts submit`) prepares and
 *     submits the edit's pair. After the commit is broadcast and the record
 *     persisted, before the reveal, it stops and reports; this process then
 *     kills it with SIGKILL. The reveal never reaches the node.
 *  3. With the commit mined and the reveal not, a fresh child reads Bitcoin:
 *     the accepted head is still the anchor (pending intent never advances it,
 *     P9.4) and `catchUp`, listing the recovery store itself, says resume.
 *  4. Another fresh child resumes: the identical commit txid, reveal txid and
 *     inscription id (P9.6). While the reveal is unmined the head is unchanged
 *     and `catchUp` waits; once it is mined the head is the edit.
 *  5. A fresh reader process, with a new empty store, no author list, only the
 *     did:btco sat and the evidence package the author exported, verifies
 *     author binding, pre-anchor history, the accepted Bitcoin head, the exact
 *     resource bytes, the network, the confirmation depth and the trust
 *     boundary (one ord index, reported; ownership provisional). Freshness is
 *     reported as not established (section 7), so it does not claim current.
 *
 * The signer is a disposable local key, not Turnkey: live client-authorized
 * signing is not established here.
 *
 * Writes a JSON receipt to stdout and to $ORIGINALS_REGTEST_RESTART_EVIDENCE
 * when set (the store directory is then kept, so its paths stay valid).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import { RegtestProvider } from '../../packages/sdk/src/adapters/providers/RegtestProvider';
import type { Utxo } from '../../packages/sdk/src/types/bitcoin';
import { OriginalsSDK, btcoAlias, keySigner } from '../../packages/sdk/src/originals/index';
import { FileStore, fileRecoveryStore } from '../../packages/sdk/src/originals/fs-store';
import { prepareEntryInscription, readAnchored, submitPreparedInscriptionOnSat } from '../../packages/sdk/src/originals/bitcoin-writer';
import { headerClock, localWallet, rpcClient } from './originals-writer-child';
import { startRegtest } from './environment';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = 'scripts/regtest/originals-writer-child.ts';
const DEPTH = 3;
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
const step = (label: string) => console.error(`[originals-restart] ${label}`);

const git = (args: string[]) => {
  const out = Bun.spawnSync(['git', ...args], { cwd: root });
  return out.success ? out.stdout.toString().trim() : null;
};
const receipt: Record<string, unknown> = {
  journey: 'originals-restart (#975)',
  sdk: { gitSha: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: (git(['status', '--porcelain']) ?? '') !== '', source: 'packages/*/src at this revision, run by Bun' },
  network: 'regtest',
  signer: 'local-disposable-key (not Turnkey)',
  liveTurnkeySigning: 'not established: needs the owner\'s authorization; no mock substitutes for it',
  landingPath: 'not exercised',
  mainnet: 'not exercised',
};
const checks: Array<{ id: string; check: string; result: 'PASS' | 'FAIL'; detail?: unknown }> = [];
function check(id: string, description: string, ok: boolean, detail?: unknown): void {
  checks.push({ id, check: description, result: ok ? 'PASS' : 'FAIL', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${id} failed: ${description} ${detail === undefined ? '' : JSON.stringify(detail)}`);
}
const processes: Array<Record<string, unknown>> = [];

step('starting Bitcoin Core and ord');
const env = await startRegtest({ indexAddresses: true, ...(process.env.ORIGINALS_REGTEST_LOGS ? { logsDir: process.env.ORIGINALS_REGTEST_LOGS } : {}) });
const dir = await mkdtemp(join(tmpdir(), 'originals-restart-'));
const stores = { root: dir, store: join(dir, 'store'), recovery: join(dir, 'recovery'), reader: join(dir, 'reader'), package: join(dir, 'evidence.zip') };
let failure: unknown;
try {
  receipt.versions = env.versions;
  receipt.stores = stores;
  const endpoints = { rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth };
  const provider = new RegtestProvider(endpoints);
  const clock = headerClock(rpcClient(endpoints));
  const walletKey = hex.encode(secp256k1.utils.randomSecretKey());
  const { address, satSigner } = localWallet(walletKey);
  const outputOf = async (txid: string, vout?: number): Promise<Utxo> => {
    const tx = await env.rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { address?: string; hex: string } }> }>('getrawtransaction', [txid, true]);
    const output = vout === undefined ? tx.vout.find((o) => o.scriptPubKey.address === address) : tx.vout[vout];
    if (!output) throw new Error(`no wallet output in ${txid}`);
    return { txid, vout: output.n, value: Math.round(output.value * 100_000_000), scriptPubKey: output.scriptPubKey.hex };
  };
  const fundUtxo = async (amount = 0.01) => outputOf(await env.fund(address, amount));
  const inMempool = (txid: string) => env.rpc('getmempoolentry', [txid]).then(() => true, () => false);
  const confirmed = async (txid: string) => (await provider.getTransactionStatus(txid)).confirmed === true;

  // Each child starts with nothing but its environment: the durable stores and the local node.
  const childEnv = (extra: Record<string, string> = {}) => ({
    ...process.env,
    ORIGINALS_CHILD_RPC_URL: env.rpcUrl, ORIGINALS_CHILD_ORD_URL: env.ordUrl, ORIGINALS_CHILD_RPC_AUTH: env.rpcAuth,
    ORIGINALS_CHILD_STORE: stores.store, ORIGINALS_CHILD_RECOVERY: stores.recovery, ...extra,
  });
  const runChild = async (role: string, mode: string, extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, CHILD, mode], { cwd: root, env: childEnv(extra), stdout: 'pipe', stderr: 'inherit' });
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    processes.push({ role, mode, pid: child.pid, exitCode: code, signal: child.signalCode ?? null });
    if (code !== 0) throw new Error(`${role} (${mode}, pid ${child.pid}) exited ${code}`);
    return JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, any>;
  };

  // The author: a did:vh with one Originals key, separate from its update key (P5.11).
  const update = localSigner('Ed25519', random32());
  const originalsKey = random32();
  const k = update.publicKeyMultibase;
  const authorGenesis = await createLog({
    versionTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#orig', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: localSigner('Ed25519', originalsKey).publicKeyMultibase }],
      assertionMethod: ['did:vh:{SCID}#orig'],
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  const authorDid = authorGenesis.state.id as string;
  const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: authorGenesis.versionId };
  const signer = keySigner({ keyType: 'Ed25519', secretKey: originalsKey, verificationMethod: author.verificationMethod });

  step('1: create, anchor and inscribe the anchoring entry; edit (durable stores)');
  const store = await FileStore.open(stores.store);
  // The author's DID evidence lives in the durable store, so a restarted writer needs no author list.
  await store.putAuthorEvidence({ did: authorDid, log: serializeLog([authorGenesis]) });
  const recoveryStore = fileRecoveryStore(stores.recovery);
  const sdk = OriginalsSDK.create({ store, authors: [], freshness: 'asserted' });
  const bytesA = new TextEncoder().encode('regtest restart photo, version 1');
  const bytesB = new TextEncoder().encode('regtest restart photo, version 2 (the edit)');
  const created = await sdk.create({ name: 'Harbor after restart', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes: bytesA }], author, signer });
  if (created.kind !== 'original') throw new Error('expected an Original');
  const did = created.original.did;
  const genesisId = created.original.checkpoint;
  const satUtxo = await fundUtxo(0.001);
  const satDid = btcoAlias('regtest', await provider.getFirstSatOfOutput!(satUtxo));
  const anchored = await sdk.anchor(did, { parent: genesisId, author, signer, sat: satDid });
  const anchorId = anchored.original.checkpoint;
  const anchorPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [satUtxo, await fundUtxo()], satSigner, changeAddress: address, feeRate: 2, network: 'regtest', provider, clock });
  const anchorSent = await submitPreparedInscriptionOnSat({ prepared: anchorPair.prepared, provider, recoveryStore });
  check('R01', 'the anchoring entry pair is broadcast through the file recovery store', anchorSent.broadcast === 'reveal_broadcast' && anchorPair.versionId === anchorId, anchorSent.broadcast);
  const unmined = await readAnchored(sdk, did, { provider, clock });
  check('R02', 'a broadcast, unmined anchor does not count (P9.4)', unmined.report.anchoring?.status !== 'anchored' && unmined.current === false, unmined.report.anchoring?.status);
  await env.mine();
  const v1 = await readAnchored(sdk, did, { provider, clock });
  check('R03', 'mined, the Original is anchored with the anchoring entry as head', v1.report.anchoring?.status === 'anchored' && v1.head === anchorId && v1.current, { head: v1.head, reasons: v1.report.reasons });
  const edit = await sdk.edit(did, { parent: v1.checkpoint, name: 'Harbor after restart, edited', resources: [{ id: 'photo', bytes: bytesB }], author, signer });
  const editId = edit.original.checkpoint;
  receipt.original = { did, sat: satDid, author: authorDid, genesis: genesisId, anchoringEntry: anchorId, edit: editId };
  receipt.anchor = { versionId: anchorId, commitTxId: anchorPair.prepared.commitTxId, revealTxId: anchorPair.prepared.revealTxId, inscriptionId: anchorPair.prepared.inscriptionId, height: v1.report.anchoring?.anchor?.height };

  step('2: writer child submits the edit and is killed after the commit, before the reveal');
  const fee = await fundUtxo();
  const writer = Bun.spawn([process.execPath, CHILD, 'submit'], {
    cwd: root, env: childEnv({ ORIGINALS_CHILD_DID: did, ORIGINALS_CHILD_WALLET_KEY: walletKey, ORIGINALS_CHILD_FEE_UTXO: JSON.stringify(fee) }),
    stdout: 'pipe', stderr: 'inherit',
  });
  const halted = await (async () => {
    const reader = writer.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), writer.exited.then(() => ({ done: true, value: undefined }))]);
      if (chunk.value) buffered += decoder.decode(chunk.value, { stream: true });
      for (const line of buffered.split('\n').slice(0, -1)) {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.event === 'halted-before-reveal') { reader.releaseLock(); return event; }
      }
      if (chunk.done) break;
    }
    throw new Error(`the writer child (pid ${writer.pid}) did not halt before the reveal`);
  })();
  check('R04', 'the writer child reports the record persisted before the reveal, with the commit in the mempool',
    halted.pid === writer.pid && halted.versionId === editId && halted.persisted === 'reveal_broadcast_unknown' && halted.commitInMempool === true,
    { persisted: halted.persisted, commitInMempool: halted.commitInMempool });
  check('R05', 'the reveal has not reached the node when the writer is killed', !(await inMempool(halted.revealTxId)));
  writer.kill('SIGKILL');
  await writer.exited;
  processes.push({ role: 'writer (killed)', mode: 'submit', pid: writer.pid, exitCode: writer.exitCode, signal: writer.signalCode ?? null });
  check('R06', 'the writer process was terminated by SIGKILL, not by an exception', writer.signalCode === 'SIGKILL' && writer.exitCode !== 0, { signal: writer.signalCode, exitCode: writer.exitCode });
  const killed = { commitTxId: halted.commitTxId as string, revealTxId: halted.revealTxId as string, inscriptionId: halted.inscriptionId as string };
  receipt.killedWriter = { pid: writer.pid, signal: writer.signalCode, ...killed, persisted: halted.persisted };

  // What a crash leaves on disk: whole records only.
  const onDisk = await readdir(stores.recovery);
  const listed = await fileRecoveryStore(stores.recovery).list();
  const record = await fileRecoveryStore(stores.recovery).load(killed.commitTxId);
  check('R07', 'the durable recovery store holds the killed pair, unchanged, beside the anchor\'s',
    listed.includes(killed.commitTxId) && listed.includes(anchorPair.prepared.commitTxId) && record?.broadcast === 'reveal_broadcast_unknown' &&
    record.prepared.revealTxId === killed.revealTxId && record.prepared.inscriptionId === killed.inscriptionId,
    { files: onDisk.sort(), broadcast: record?.broadcast });
  check('R08', 'after the kill the commit is in the mempool and the reveal is not', (await inMempool(killed.commitTxId)) && !(await inMempool(killed.revealTxId)));

  step('3: commit mined, reveal not: a fresh process reads Bitcoin');
  await env.mine();
  check('R09', 'the commit is mined and the reveal is not', (await confirmed(killed.commitTxId)) && !(await confirmed(killed.revealTxId)));
  const midway = await runChild('fresh reader of the writer stores', 'step', { ORIGINALS_CHILD_DID: did });
  check('R10', 'pending intent never advances the accepted head: Bitcoin still shows the anchoring entry (P9.4)',
    midway.step.accepted === anchorId && midway.step.committed === editId, midway.step);
  check('R11', 'catchUp in a fresh process, listing the recovery store itself, resumes the recorded pair rather than preparing another (P9.6)',
    midway.step.action === 'resume' && midway.step.recoveryId === killed.commitTxId && midway.step.versionId === editId, midway.step);

  step('4: a fresh writer resumes the identical pair');
  const resumed = await runChild('restarted writer', 'resume', { ORIGINALS_CHILD_DID: did });
  check('R12', 'the restarted writer resumes the identical pair: same commit txid, reveal txid and inscription id',
    resumed.resumed.commitTxId === killed.commitTxId && resumed.resumed.revealTxId === killed.revealTxId && resumed.resumed.inscriptionId === killed.inscriptionId &&
    resumed.resumed.broadcast === 'reveal_broadcast' && resumed.resumed.error === null, resumed.resumed);
  check('R13', 'the restarted writer started with no in-memory state (another pid)', resumed.pid !== writer.pid && midway.pid !== writer.pid && resumed.pid !== process.pid);
  check('R14', 'with the reveal broadcast but unmined, the head is unchanged and catchUp waits instead of preparing again',
    resumed.after.action === 'wait-for-confirmation' && resumed.after.reason === 'unconfirmed' && resumed.after.recoveryId === killed.commitTxId && resumed.after.accepted === anchorId,
    resumed.after);
  check('R15', 'the reveal now in the mempool is the killed writer\'s', await inMempool(killed.revealTxId));
  const stillPending = await runChild('fresh reader of the writer stores', 'step', { ORIGINALS_CHILD_DID: did });
  check('R16', 'a further fresh read before the reveal confirms: head unchanged', stillPending.step.accepted === anchorId && stillPending.step.action === 'wait-for-confirmation', stillPending.step);
  const [revealBlock] = await env.mine();
  const done = await runChild('fresh reader of the writer stores', 'step', { ORIGINALS_CHILD_DID: did });
  check('R17', 'only the confirmed reveal advances the accepted head, to the edit', done.step.action === 'done' && done.step.accepted === editId && done.step.current === true, done.step);
  const v2 = await readAnchored(OriginalsSDK.create({ store: await FileStore.open(stores.store), authors: [], freshness: 'asserted' }), did, { provider, clock });
  const accepted = v2.report.anchoring?.accepted.at(-1);
  check('R18', 'the inscription Bitcoin accepts is the resumed pair', accepted?.inscription === killed.inscriptionId && accepted?.versionId === editId, accepted);
  receipt.resume = { midwayPid: midway.pid, resumePid: resumed.pid, ...resumed.resumed, revealBlock, acceptedHeight: accepted?.height, recordAfter: resumed.record };

  step('5: a fresh reader verifies from the did:btco sat and the author\'s evidence package');
  if (DEPTH > 1) await env.mine(DEPTH - 1);
  const exported = await OriginalsSDK.create({ store: await FileStore.open(stores.store), authors: [], freshness: 'asserted' }).package(did);
  await writeFile(stores.package, exported.bytes);
  check('R19', 'the author exports a complete evidence package at the edit', exported.manifest.completeness === 'complete' && exported.manifest.checkpoint === editId, exported.manifest);
  await mkdir(stores.reader, { recursive: true });
  check('R20', 'the reader starts from an empty store', (await readdir(stores.reader)).length === 0);
  const read = await runChild('fresh reader (public inputs only)', 'read', { ORIGINALS_CHILD_SAT: satDid, ORIGINALS_CHILD_PACKAGE: stores.package, ORIGINALS_CHILD_READER_STORE: stores.reader });
  const a = read.anchoring;
  check('R21', 'author binding verifies from the package\'s author evidence', read.authorBinding.status === 'valid' && read.identityEvidence.status === 'complete' && read.identityEvidence.author === authorDid, { authorBinding: read.authorBinding, identityEvidence: read.identityEvidence });
  check('R22', 'pre-anchor history: genesis, then the anchoring entry, then the edit, all valid',
    read.history.status === 'valid' && read.history.entries === 3 && JSON.stringify(read.packageVersionIds) === JSON.stringify([genesisId, anchorId, editId]) && a?.anchor?.versionId === anchorId,
    { history: read.history, packageVersionIds: read.packageVersionIds });
  check('R23', 'the accepted Bitcoin head is the edit, through the resumed inscription, ordering anchored',
    a?.status === 'anchored' && read.head === editId && read.ordering === 'anchored' && a.accepted.at(-1)?.inscription === killed.inscriptionId && a.anchor?.inscription === anchorPair.prepared.inscriptionId && a.superseded === 0,
    { head: read.head, ordering: read.ordering, current: read.current, reasons: read.reasons });
  const digest = (b: Uint8Array) => hex.encode(sha256(b));
  const versions = read.resources.versions as Array<{ version: number; sha256: string | null; length: number | null; bytes: string }>;
  check('R24', 'exact resource bytes: both versions present and byte-identical to what the author signed',
    read.resources.status === 'available' && versions.length === 2 && versions.every((v) => v.bytes === 'verified') &&
    versions[0].sha256 === digest(bytesA) && versions[0].length === bytesA.length && versions[1].sha256 === digest(bytesB) && versions[1].length === bytesB.length,
    read.resources);
  check('R25', 'network: the sat is a regtest did:btco and the provider read it on regtest', read.snapshot.network === 'regtest' && a?.sat === satDid && satDid.startsWith('did:btco:reg:'), { network: read.snapshot.network, sat: a?.sat });
  const tipHeight = read.snapshot.tip.height as number;
  check('R26', `confirmation depth: the accepted edit inscription has ${DEPTH} confirmations at the tip read`,
    a?.accepted.at(-1)?.confirmations === DEPTH && tipHeight - (a?.accepted.at(-1)?.height ?? 0) + 1 === DEPTH && read.ownership?.confirmations >= DEPTH,
    { tip: read.snapshot.tip, accepted: a?.accepted.at(-1), anchorConfirmations: a?.anchor?.confirmations, ownerConfirmations: read.ownership?.confirmations });
  check('R27', 'trust boundary: one ord index consulted and reported; ownership provisional; uniqueness not established',
    read.evidenceIndexes === 1 && read.ownership?.indexes === 1 && read.ownership?.status === 'provisional' && a?.uniqueness === 'not-established' && read.snapshot.indexHealthy && read.snapshot.enumerationComplete,
    { provider: read.provider, indexes: read.evidenceIndexes, ownership: read.ownership, uniqueness: a?.uniqueness });
  check('R28', 'the reader stored nothing (load verifies without storing)', (await readdir(join(stores.reader, 'originals'))).length === 0);
  // Section 7: a reader with only public inputs cannot vouch that the author DID or
  // asset log it holds is the latest. That is reported, never passed.
  check('R29', 'freshness is reported separately as not established, so the fresh reader does not claim current',
    read.current === false && read.reasons.includes('author-freshness-not-established'), { current: read.current, reasons: read.reasons });
  receipt.reader = {
    pid: read.pid, store: read.store, inputs: { sat: satDid, package: stores.package, packageSha256: digest(exported.bytes) },
    provider: read.provider, head: read.head, ordering: read.ordering, current: read.current, reasons: read.reasons,
    tip: read.snapshot.tip, anchor: a?.anchor, accepted: a?.accepted, ownership: read.ownership,
    resources: versions,
  };
  receipt.result = 'passed';
} catch (error) {
  failure = error;
  receipt.result = 'failed';
  receipt.error = error instanceof Error ? error.message : String(error);
} finally {
  receipt.processes = [{ role: 'journey (parent)', pid: process.pid }, ...processes];
  receipt.checks = checks;
  await env.stop();
  receipt.storesKept = !!process.env.ORIGINALS_REGTEST_RESTART_EVIDENCE;
  if (!receipt.storesKept) await rm(dir, { recursive: true, force: true });
  const summary = JSON.stringify(receipt, null, 2);
  console.log(summary);
  if (process.env.ORIGINALS_REGTEST_RESTART_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_RESTART_EVIDENCE, summary);
}
if (failure) throw failure;
