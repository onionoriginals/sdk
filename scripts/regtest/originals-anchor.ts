/**
 * Anchored Originals on real Bitcoin Core 31.1 and ord 0.29.0, regtest only
 * (plan 011 PR 10; plan 012). Nothing here touches mainnet or testnet.
 *
 * The journey, each step asserted:
 *  1. A local Original is anchored to a sat its writer holds. The SDK verifies
 *     the log and the author's identity evidence through the anchoring entry,
 *     tells the author what Bitcoin will not hold, and inscribes the whole
 *     stored log from genesis through the anchoring entry (P9.17, P9.18): ord
 *     returns exactly those stored lines. Broadcast but unmined, it does not
 *     count (P9.4) and is labelled pending Bitcoin acceptance; mined, the
 *     Original verifies as anchored and current, with provisional ownership
 *     of the reveal output (P9.11, P9.16).
 *  2. An edit is reinscribed on the same sat by spending the output that now
 *     holds it (P9.12, P9.13).
 *  3. A pair whose first funding UTXO holds another sat is refused.
 *  4. A reorganisation that replaces the edit's block with an empty one is
 *     reported as authoritative-source-changed, never applied silently; the
 *     next block includes the edit again (P9.5, C12-40).
 *  5. A crash between commit and reveal broadcast leaves a durable record;
 *     resuming rebroadcasts the same pair, and the boundary advances only once
 *     the reveal is mined (P9.4, P9.6).
 *  6. An entry the author signs but nobody inscribes is never current (P9.12),
 *     and an explicitly requested entry that skips it is refused.
 *  7. Catching up: the two uninscribed entries are published one block at a
 *     time, re-reading Bitcoin's accepted head before each. A crash before
 *     the first reveal is resumed as the same pair, and a pending reveal is
 *     waited on, never prepared twice (P9.4, P9.6, P9.13).
 *  8. A second Original with an editor: Bob (granted the photo) replaces it
 *     before the anchor, Alice anchors and edits, and Bob edits again, all
 *     before anything is published. Catching up inscribes the log through the
 *     anchoring entry (Bob's entry inside it, his identity evidence verified
 *     first), then Alice's edit, then Bob's editor entry, one per later block;
 *     the holder inscribes Bob's entry and Bitcoin accepts it (P5.16, P9.12).
 *     A reorganisation then replaces the block holding Alice's edit: catchUp
 *     re-reads the accepted head (back to the anchor), re-derives the queue
 *     and waits on the recorded pair back in the mempool, preparing nothing;
 *     the next block includes it again.
 *  9. Fresh readers: each Original verifies from its sat alone, with no copy
 *     of the log, plus the off-chain signer DID histories (P9.17, P9.18); and
 *     a recipient of the sat verifies the sender's handoff (resource bytes and
 *     DID histories) against the sat with an empty store.
 *
 * Writes a JSON evidence summary to stdout (and to $ORIGINALS_REGTEST_EVIDENCE
 * when set).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import { RegtestProvider } from '../../packages/sdk/src/adapters/providers/RegtestProvider';
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore } from '../../packages/sdk/src/bitcoin/inscription-recovery';
import type { BitcoinSigner } from '../../packages/sdk/src/types/common';
import type { Utxo } from '../../packages/sdk/src/types/bitcoin';
import { verifyOriginal, type AuthorDidEvidence } from '@originals/vh/originals';
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, keySigner, satEvidence } from '../../packages/sdk/src/originals/index';
import { catchUp, prepareEntryInscription, readAnchored, resumeEntryInscription, submitEntryInscription, transferHandoff, verifyHandoff, type CatchUpStep } from '../../packages/sdk/src/originals/bitcoin-writer';
import type { OriginalView } from '../../packages/sdk/src/originals/index';
import { startRegtest } from './environment';

const random32 = () => crypto.getRandomValues(new Uint8Array(32));
/** The one index every read uses, reported as used (P9.11). */
const ORD = 'ord-0.29.0-regtest';
const evidence: Record<string, unknown> = {};

const step = (label: string) => console.error(`[originals-anchor] ${label}`);
step('starting Bitcoin Core and ord');
const env = await startRegtest({ indexAddresses: true, ...(process.env.ORIGINALS_REGTEST_LOGS ? { logsDir: process.env.ORIGINALS_REGTEST_LOGS } : {}) });
try {
  evidence.versions = env.versions;
  const provider = new RegtestProvider(env);

  // The writer's Bitcoin wallet: one key, P2WPKH, signing the commit locally.
  const walletKey = secp256k1.utils.randomSecretKey();
  const wallet = btc.p2wpkh(secp256k1.getPublicKey(walletKey, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' });
  const satSigner: BitcoinSigner = {
    signAndFinalizeCommitPsbt(psbtBase64) {
      const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
      tx.sign(walletKey);
      tx.finalize();
      return Promise.resolve(tx.hex);
    },
  };
  const outputOf = async (txid: string, vout?: number): Promise<Utxo> => {
    const tx = await env.rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { address?: string; hex: string } }> }>('getrawtransaction', [txid, true]);
    const output = vout === undefined ? tx.vout.find((o) => o.scriptPubKey.address === wallet.address) : tx.vout[vout];
    assert.ok(output, `no wallet output in ${txid}`);
    return { txid, vout: output.n, value: Math.round(output.value * 100_000_000), scriptPubKey: output.scriptPubKey.hex };
  };
  const fundUtxo = async (amount = 0.01) => outputOf(await env.fund(wallet.address!, amount));

  const records = new Map<string, InscriptionRecoveryRecord>();
  const recoveryStore: InscriptionRecoveryStore = {
    save: (r) => Promise.resolve(void records.set(r.recoveryId, structuredClone(r))),
    load: (id) => Promise.resolve(structuredClone(records.get(id))),
    list: () => Promise.resolve([...records.keys()]),
  };
  const clock = new InscriptionClock(async (height) => {
    const hash = await env.rpc<string>('getblockhash', [height]);
    // prev (Core's previousblockhash) lets the clock check each block extends the one before it.
    const header = await env.rpc<{ time: number; previousblockhash?: string }>('getblockheader', [hash]);
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  });

  // A did:vh with one Originals key, separate from its update key (P5.11).
  const identity = async (fragment: string) => {
    const update = random32();
    const signingKey = random32();
    const k = localSigner('Ed25519', update).publicKeyMultibase;
    const genesis = await createLog({
      versionTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [k] },
      state: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: 'did:vh:{SCID}',
        verificationMethod: [{ id: `did:vh:{SCID}#${fragment}`, type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: localSigner('Ed25519', signingKey).publicKeyMultibase }],
        assertionMethod: [`did:vh:{SCID}#${fragment}`],
      },
      sign: signWith(localSigner('Ed25519', update), { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
    });
    const did = genesis.state.id as string;
    const ref = { did, verificationMethod: `${did}#${fragment}`, versionId: genesis.versionId };
    const evidence: AuthorDidEvidence = { did, log: serializeLog([genesis]) };
    return { did, ref, evidence, signer: keySigner({ keyType: 'Ed25519', secretKey: signingKey, verificationMethod: ref.verificationMethod }) };
  };
  // The author, Alice, and an editor, Bob (step 8).
  const alice = await identity('orig');
  const bob = await identity('edit');
  const authorDid = alice.did;
  const author = alice.ref;
  const signer = alice.signer;
  const originals = new MemoryStore();
  const sdk = OriginalsSDK.create({ store: originals, authors: [alice.evidence, bob.evidence] });
  const recorded = () => ({ recoveryStore, recoveryIds: [...records.keys()] });
  /** The exact stored lines of an Original, oldest first. */
  const storedLines = async (of: string) => (await sdk.committedLog(of)).trimEnd().split('\n');
  /** What ord shows on a sat, as evidence (one index, reported). */
  const readSat = async (satAlias: string) => {
    const snapshot = await provider.getSatSnapshot!(satAlias.split(':').at(-1)!, { bodies: 'originals' });
    const satpoint = snapshot.ownership.satpoint;
    const ownerConfirmations = satpoint ? (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0 : 0;
    return { snapshot, evidence: await satEvidence(snapshot, { clock, ownerConfirmations, index: ORD }) };
  };
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  step('1: anchor');
  // 1. Create locally, anchor to a sat this wallet holds, inscribe the anchoring entry.
  const created = await sdk.create({ name: 'Harbor at dawn', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes: new TextEncoder().encode('regtest photo') }], author, signer });
  assert.equal(created.kind, 'original');
  if (created.kind !== 'original') throw new Error('unreachable');
  const did = created.original.did;
  const satUtxo = await fundUtxo(0.001);
  const sat = await provider.getFirstSatOfOutput!(satUtxo);
  const satDid = btcoAlias('regtest', sat);
  const anchored = await sdk.anchor(did, { parent: created.original.checkpoint, author, signer, sat: satDid });
  assert.equal(anchored.original.report.anchoring?.status, 'unverified');

  const anchorPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [satUtxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.equal(anchorPair.versionId, anchored.original.checkpoint);
  // The anchoring inscription carries the whole stored log through the anchoring entry (P9.17).
  const lines1 = await storedLines(did);
  assert.deepEqual(anchorPair.carries, [created.original.checkpoint, anchored.original.checkpoint]);
  // What Bitcoin will not hold: the photo's bytes and the author's did:vh history (P9.18).
  assert.deepEqual(anchorPair.offChain.identities, [{ did: authorDid, role: 'author', held: true }]);
  assert.deepEqual(anchorPair.offChain.resources.map((r) => [r.resource, r.version, r.held]), [['photo', 1, true]]);
  assert.equal(anchorPair.offChain.replication, 'not-guaranteed');
  // Checked send: still next, no other pair in flight, verified through the entry again (P9.18).
  const sent = await submitEntryInscription({ sdk, did, pair: anchorPair, provider, clock, index: ORD, recoveryStore });
  assert.equal(sent.broadcast, 'reveal_broadcast');
  const pending = await readAnchored(sdk, did, { provider, clock, index: ORD, ...recorded() });
  assert.notEqual(pending.report.anchoring?.status, 'anchored', 'a broadcast, unmined inscription must not count (P9.4)');
  assert.equal(pending.publication, 'pending-bitcoin-acceptance', 'broadcast and unconfirmed, the anchor is pending Bitcoin acceptance (P9.18)');
  assert.equal(pending.current, false);
  await env.mine();
  const v1 = await readAnchored(sdk, did, { provider, clock, index: ORD, ...recorded() });
  assert.equal(v1.report.anchoring?.status, 'anchored');
  assert.equal(v1.publication, 'anchored', 'confirmed, the Original verifies as anchored (P9.18)');
  const onOrd = (await readSat(satDid)).snapshot.publications.find((p) => p.id === anchorPair.prepared.inscriptionId);
  assert.ok(onOrd?.body.status === 'complete');
  const anchorBody = decode(onOrd.body.bytes);
  assert.equal(anchorBody, `${lines1.slice(0, 2).join('\n')}\n`, 'ord returns the exact stored lines, genesis through the anchoring entry');
  assert.equal(onOrd.body.mediaType, 'application/vnd.originals.vh+jsonl');
  assert.equal(onOrd.body.metadata ?? null, null, 'no metadata on an Originals inscription (P9.17)');
  assert.equal(v1.head, anchored.original.checkpoint);
  assert.equal(v1.report.ordering, 'anchored');
  assert.equal(v1.report.ownership?.output, `${anchorPair.prepared.revealTxId}:0`);
  assert.equal(v1.current, true, JSON.stringify(v1.report.reasons));
  evidence.anchor = {
    did, sat: satDid, commitTxId: anchorPair.prepared.commitTxId, revealTxId: anchorPair.prepared.revealTxId, inscription: anchorPair.prepared.inscriptionId,
    carries: anchorPair.carries, bodyBytes: onOrd.body.bytes.length, bodyIsStoredLines: true,
    publication: [pending.publication, v1.publication], height: v1.report.anchoring?.anchor?.height, ownership: v1.report.ownership,
    offChain: anchorPair.offChain,
  };

  step('2: reinscribe');
  // 2. Edit, and reinscribe on the same sat by spending the output that holds it.
  const edit = await sdk.edit(did, { parent: v1.checkpoint, name: 'Harbor at dawn, on Bitcoin', author, signer });
  const holding = await outputOf(anchorPair.prepared.revealTxId, 0);
  const editPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [holding, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.deepEqual(editPair.carries, [edit.original.checkpoint], 'after the anchor, one entry per inscription (P9.17)');
  assert.equal((await submitEntryInscription({ sdk, did, pair: editPair, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  const editBlock = (await env.mine())[0];
  const v2 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(v2.head, edit.original.checkpoint);
  assert.equal(v2.state.name, 'Harbor at dawn, on Bitcoin');
  assert.equal(v2.report.anchoring?.accepted.length, 1);
  assert.equal(v2.current, true, JSON.stringify(v2.report.reasons));
  evidence.edit = { inscription: editPair.prepared.inscriptionId, block: editBlock, ownership: v2.report.ownership };

  step('3: already inscribed');
  // 3. The head Bitcoin already shows is not inscribed again (P9.13).
  await assert.rejects(
    prepareEntryInscription({ sdk, did, versionId: edit.original.checkpoint, fundingUtxos: [await outputOf(editPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null }),
    (error: unknown) => (error as { code?: string }).code === 'HEAD_NOT_NEXT',
  );

  step('4: reorg');
  // 4. A reorganisation replaces the edit's block with an empty one, so the edit falls back
  //    to the mempool: reported, not applied silently. The next block includes it again.
  const oldTip = (await env.rpc<{ blocks: number }>('getblockchaininfo')).blocks;
  await env.rpc('invalidateblock', [editBlock]);
  // Empty blocks until the new chain is longer than the old one, so ord follows the reorg.
  const replacement = await env.rpc<{ hash: string }>('generateblock', [wallet.address!, []]);
  while ((await env.rpc<{ blocks: number }>('getblockchaininfo')).blocks <= oldTip) await env.rpc('generateblock', [wallet.address!, []]);
  await env.sync();
  const reorged = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(reorged.head, anchored.original.checkpoint);
  assert.ok(reorged.report.reasons.includes('authoritative-source-changed'), JSON.stringify(reorged.report.reasons));
  assert.equal(reorged.current, false);
  const reincluded = (await env.mine())[0];
  const restored = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(restored.head, edit.original.checkpoint);
  assert.equal(restored.current, true, JSON.stringify(restored.report.reasons));
  evidence.reorg = { invalidated: editBlock, replacement: replacement.hash, reported: reorged.report.reasons.filter((r) => r === 'authoritative-source-changed'), reincludedIn: reincluded, restoredHead: restored.head };

  step('5: crash and resume');
  // 5. A crash after the commit broadcast: the record survives, resume sends the same pair.
  const third = await sdk.edit(did, { parent: restored.checkpoint, name: 'Harbor at dusk', author, signer });
  // A pair whose first funding UTXO holds another sat is refused, so only the holder extends it.
  await assert.rejects(
    prepareEntryInscription({ sdk, did, fundingUtxos: [await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null }),
    (error: unknown) => (error as { code?: string }).code === 'WRONG_SAT',
  );
  const thirdPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [await outputOf(editPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  const crashing = Object.create(provider) as RegtestProvider;
  crashing.broadcastTransaction = (raw: unknown) => (raw === thirdPair.prepared.revealTxHex ? Promise.reject(new Error('process died before the reveal')) : provider.broadcastTransaction(raw));
  // The checked send, through a node that dies before the reveal: the record is saved before each broadcast,
  // so the kill leaves it mid-way for the recovery state machine below (#975).
  const crashed = await submitEntryInscription({ sdk, did, pair: thirdPair, provider: crashing, clock, index: ORD, recoveryStore }).catch((error: unknown) => ({ error }));
  const stored = records.get(thirdPair.prepared.commitTxId);
  assert.ok(stored && stored.broadcast !== 'reveal_broadcast', `the record shows the reveal unsent: ${stored?.broadcast}`);
  await assert.rejects(env.rpc('getmempoolentry', [thirdPair.prepared.revealTxId]), 'the reveal never reached the node');
  await env.mine();
  assert.equal((await provider.getTransactionStatus(thirdPair.prepared.commitTxId)).confirmed, true, 'the commit is mined');
  assert.equal((await provider.getTransactionStatus(thirdPair.prepared.revealTxId)).confirmed, false, 'the reveal is not');
  const midway = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(midway.head, edit.original.checkpoint, 'a commit without its reveal never advances the boundary (P9.4)');
  // The checked resume: catch-up chooses this pair and the log verifies through it again (P9.18).
  const resumed = await resumeEntryInscription({ sdk, did, provider, clock, index: ORD, recoveryStore, recoveryId: thirdPair.prepared.commitTxId });
  assert.equal(resumed.revealTxId, thirdPair.prepared.revealTxId, 'resume rebroadcasts the same pair (P9.6)');
  await env.mine();
  const v3 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(v3.head, third.original.checkpoint);
  assert.equal(v3.report.anchoring?.accepted.at(-1)?.inscription, thirdPair.prepared.inscriptionId, 'the resumed pair is the one Bitcoin shows');
  assert.equal(v3.current, true, JSON.stringify(v3.report.reasons));
  evidence.retry = { crashed: 'error' in (crashed as object) ? String((crashed as { error: unknown }).error) : (crashed as { broadcast: string }).broadcast, recordState: stored?.broadcast, resumed: resumed.broadcast, head: v3.head };

  step('6: uninscribed entry');
  // 6. An entry the author signs but nobody inscribes is never current.
  const local = await sdk.edit(did, { parent: v3.checkpoint, name: 'Only in a local copy', author, signer });
  const v4 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(v4.head, third.original.checkpoint);
  assert.equal(v4.report.anchoring?.superseded, 1);
  assert.notEqual(v4.head, local.original.checkpoint);
  // An entry after it cannot be inscribed first: Bitcoin would never accept it (P9.13).
  const skips = await sdk.edit(did, { parent: local.original.checkpoint, name: 'Skips one', author, signer });
  await assert.rejects(
    prepareEntryInscription({ sdk, did, versionId: skips.original.checkpoint, fundingUtxos: [await outputOf(thirdPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null }),
    (error: unknown) => (error as { code?: string }).code === 'HEAD_NOT_NEXT',
  );
  evidence.uninscribed = { signed: local.original.checkpoint, head: v4.head, superseded: v4.report.anchoring?.superseded, skipRefused: 'HEAD_NOT_NEXT' };

  step('7: catch up');
  // 7. Publish the uninscribed entries one block at a time from the recovery store and a fresh read.
  const holdingOf = async (view: OriginalView) => {
    const [txid, vout] = view.report.ownership!.output.split(':');
    return outputOf(txid, Number(vout));
  };
  const plan = (of: string) => catchUp({ sdk, did: of, provider, clock, index: ORD, recoveryStore, recoveryIds: [...records.keys()] });
  const actions: string[] = [];
  const expectStep = async <A extends CatchUpStep['action']>(of: string, action: A, versionId?: string) => {
    const next = await plan(of);
    actions.push(`${next.action}${'versionId' in next ? ` ${next.versionId}` : ''}`);
    assert.equal(next.action, action, JSON.stringify({ ...next, pending: undefined }));
    if (versionId && 'versionId' in next) assert.equal(next.versionId, versionId);
    return next as Extract<CatchUpStep, { action: A }>;
  };
  const start = await expectStep(did, 'prepare', local.original.checkpoint);
  assert.equal(start.pending.committed, skips.original.checkpoint);
  assert.equal(start.pending.accepted, third.original.checkpoint);
  assert.deepEqual(start.pending.queue, [local.original.checkpoint, skips.original.checkpoint]);
  const catch1 = await prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(start.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.equal(catch1.versionId, local.original.checkpoint);
  assert.equal(catch1.remaining, 1);
  // The process dies after the commit broadcast, before the reveal.
  const crashing1 = Object.create(provider) as RegtestProvider;
  crashing1.broadcastTransaction = (raw: unknown) => (raw === catch1.prepared.revealTxHex ? Promise.reject(new Error('process died before the reveal')) : provider.broadcastTransaction(raw));
  // Checked send; the node dies before the reveal, leaving the record mid-way for catch-up to resume.
  await submitEntryInscription({ sdk, did, pair: catch1, provider: crashing1, clock, index: ORD, recoveryStore }).catch(() => undefined);
  const resume1 = await expectStep(did, 'resume', local.original.checkpoint);
  assert.equal(resume1.recoveryId, catch1.prepared.commitTxId, 'the recorded pair is resumed, not a new one prepared (P9.6)');
  const resumedCatch = await resumeEntryInscription({ sdk, did, provider, clock, index: ORD, recoveryStore, recoveryId: resume1.recoveryId });
  assert.equal(resumedCatch.revealTxId, catch1.prepared.revealTxId);
  const waiting1 = await expectStep(did, 'wait-for-confirmation', local.original.checkpoint);
  assert.equal(waiting1.recoveryId, catch1.prepared.commitTxId, 'a pending reveal is waited on, never prepared twice');
  const catchBlock1 = (await env.mine())[0];
  const after1 = await expectStep(did, 'prepare', skips.original.checkpoint);
  assert.equal(after1.pending.accepted, local.original.checkpoint, 'the accepted head is re-read before advancing');
  assert.deepEqual(after1.replaces, []);
  const catch2 = await prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(after1.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.equal(catch2.versionId, skips.original.checkpoint);
  assert.equal((await submitEntryInscription({ sdk, did, pair: catch2, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  const waiting2 = await expectStep(did, 'wait-for-confirmation', skips.original.checkpoint);
  assert.equal(waiting2.recoveryId, catch2.prepared.commitTxId);
  const catchBlock2 = (await env.mine())[0];
  const caughtUp = await expectStep(did, 'done');
  const v5 = caughtUp.pending.view;
  assert.equal(v5.head, skips.original.checkpoint);
  assert.equal(v5.state.name, 'Skips one');
  assert.equal(v5.current, true, JSON.stringify(v5.report.reasons));
  const tail = v5.report.anchoring!.accepted.slice(-2);
  assert.deepEqual(tail.map((a) => a.inscription), [catch1.prepared.inscriptionId, catch2.prepared.inscriptionId]);
  assert.ok(tail[0].height > v3.report.anchoring!.accepted.at(-1)!.height && tail[1].height > tail[0].height, 'one accepted entry per later block (P9.13)');
  await assert.rejects(
    prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(v5), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null }),
    (error: unknown) => (error as { code?: string }).code === 'NOTHING_TO_INSCRIBE',
  );
  evidence.catchUp = {
    queue: start.pending.queue, actions: actions.splice(0),
    crashedAfterCommit: catch1.prepared.commitTxId, resumedReveal: resumedCatch.revealTxId,
    published: tail.map((a) => ({ versionId: a.versionId, inscription: a.inscription, height: a.height })),
    blocks: [catchBlock1, catchBlock2], head: v5.head, current: v5.current,
  };

  step('8: an editor, and edits before the anchor is published');
  // 8. A second Original with an editor. Bob replaces the photo before the anchor; Alice anchors
  //    and edits, and Bob edits again, all before anything is published.
  const bytes = (text: string) => new TextEncoder().encode(text);
  const grant = { did: bob.did, name: false, metadata: false, resources: ['photo'] };
  const lighthouse = await sdk.create({ name: 'Lighthouse', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes: bytes('regtest lighthouse') }], editors: [grant], author, signer });
  if (lighthouse.kind !== 'original') throw new Error('expected an Original');
  const did2 = lighthouse.original.did;
  const asBob = { editor: bob.ref, signer: bob.signer };
  const bobBefore = await sdk.edit(did2, { parent: lighthouse.original.checkpoint, resources: [{ id: 'photo', bytes: bytes('regtest lighthouse, Bob\'s crop') }], ...asBob });
  const sat2Utxo = await fundUtxo(0.001);
  const sat2 = btcoAlias('regtest', await provider.getFirstSatOfOutput!(sat2Utxo));
  const anchored2 = await sdk.anchor(did2, { parent: bobBefore.original.checkpoint, author, signer, sat: sat2 });
  const early = await sdk.edit(did2, { parent: anchored2.original.checkpoint, name: 'Lighthouse, edited before publishing', author, signer });
  const bobAfter = await sdk.edit(did2, { parent: early.original.checkpoint, resources: [{ id: 'photo', bytes: bytes('regtest lighthouse, Bob\'s second crop') }], ...asBob });
  const lines2 = await storedLines(did2);
  assert.equal(lines2.length, 5);
  const first2 = await expectStep(did2, 'prepare', anchored2.original.checkpoint);
  assert.equal(first2.pending.accepted, null);
  assert.equal(first2.pending.publication, 'not-anchored');
  assert.deepEqual(first2.pending.queue, [anchored2.original.checkpoint, early.original.checkpoint, bobAfter.original.checkpoint]);
  await assert.rejects(
    prepareEntryInscription({ sdk, did: did2, versionId: early.original.checkpoint, fundingUtxos: [sat2Utxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null }),
    (error: unknown) => (error as { code?: string }).code === 'HEAD_NOT_NEXT',
  );
  // Without Bob's DID history the log through the anchoring entry does not verify: nothing is inscribed (P9.18).
  const forgetful = OriginalsSDK.create({ store: originals, authors: [alice.evidence] });
  const refusedWithoutBob = await prepareEntryInscription({ sdk: forgetful, did: did2, fundingUtxos: [sat2Utxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore: null })
    .then(() => 'prepared', (error: unknown) => (error as { code?: string }).code ?? String(error));
  assert.equal(refusedWithoutBob, 'ANCHORING_NOT_VERIFIED', 'the same store without the editor\'s DID history refuses to inscribe');
  const anchor2Pair = await prepareEntryInscription({ sdk, did: did2, fundingUtxos: [sat2Utxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.equal(anchor2Pair.versionId, anchored2.original.checkpoint);
  assert.deepEqual(anchor2Pair.carries, [lighthouse.original.checkpoint, bobBefore.original.checkpoint, anchored2.original.checkpoint]);
  assert.deepEqual(anchor2Pair.offChain.identities, [{ did: authorDid, role: 'author', held: true }, { did: bob.did, role: 'editor', held: true }]);
  assert.equal((await submitEntryInscription({ sdk, did: did2, pair: anchor2Pair, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  const waiting2a = await expectStep(did2, 'wait-for-confirmation', anchored2.original.checkpoint);
  assert.equal(waiting2a.pending.publication, 'pending-bitcoin-acceptance');
  await env.mine();
  const anchorOnOrd = (await readSat(sat2)).snapshot.publications.find((p) => p.id === anchor2Pair.prepared.inscriptionId);
  assert.ok(anchorOnOrd?.body.status === 'complete');
  assert.equal(decode(anchorOnOrd.body.bytes), `${lines2.slice(0, 3).join('\n')}\n`, 'ord returns the exact stored lines, genesis through the anchoring entry, Bob\'s entry inside');
  const second2 = await expectStep(did2, 'prepare', early.original.checkpoint);
  assert.equal(second2.pending.accepted, anchored2.original.checkpoint);
  assert.equal(second2.pending.publication, 'anchored');
  const early2Pair = await prepareEntryInscription({ sdk, did: did2, fundingUtxos: [await holdingOf(second2.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.deepEqual(early2Pair.carries, [early.original.checkpoint]);
  assert.equal((await submitEntryInscription({ sdk, did: did2, pair: early2Pair, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  const early2Block = (await env.mine())[0];
  assert.equal((await expectStep(did2, 'prepare', bobAfter.original.checkpoint)).pending.accepted, early.original.checkpoint);
  // A reorganisation during catch-up: the block holding Alice's edit is replaced by empty ones, so its
  // commit and reveal fall back to the mempool. catchUp re-derives the queue from the head Bitcoin
  // shows now and waits on the recorded pair: nothing prepared, the next entry not skipped (P9.4, P9.13).
  const tip2 = (await env.rpc<{ blocks: number }>('getblockchaininfo')).blocks;
  await env.rpc('invalidateblock', [early2Block]);
  while ((await env.rpc<{ blocks: number }>('getblockchaininfo')).blocks <= tip2) await env.rpc('generateblock', [wallet.address!, []]);
  await env.sync();
  const reorged2 = await expectStep(did2, 'wait-for-confirmation', early.original.checkpoint);
  assert.equal(reorged2.reason, 'unconfirmed');
  assert.equal(reorged2.recoveryId, early2Pair.prepared.commitTxId, 'the recorded pair is waited on, not prepared again');
  assert.equal(reorged2.pending.accepted, anchored2.original.checkpoint, 'the accepted head is re-read: back to the anchor');
  assert.deepEqual(reorged2.pending.queue, [early.original.checkpoint, bobAfter.original.checkpoint]);
  assert.equal(reorged2.pending.publication, 'anchored');
  assert.ok((await provider.getTransactionStatus(early2Pair.prepared.revealTxId)).inMempool, 'the reveal is back in the mempool');
  const early2Again = (await env.mine())[0];
  evidence.reorgDuringCatchUp = {
    invalidated: early2Block, reincludedIn: early2Again, waitedOn: reorged2.recoveryId,
    acceptedAfterReorg: reorged2.pending.accepted, queueAfterReorg: reorged2.pending.queue,
  };
  // The holder inscribes Bob's editor entry like any other (P9.12, P5.16).
  const third2 = await expectStep(did2, 'prepare', bobAfter.original.checkpoint);
  assert.equal(third2.pending.accepted, early.original.checkpoint);
  const bob2Pair = await prepareEntryInscription({ sdk, did: did2, fundingUtxos: [await holdingOf(third2.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.deepEqual(bob2Pair.carries, [bobAfter.original.checkpoint]);
  assert.equal((await submitEntryInscription({ sdk, did: did2, pair: bob2Pair, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  await env.mine();
  const done2 = await expectStep(did2, 'done');
  const v6 = done2.pending.view;
  assert.equal(v6.head, bobAfter.original.checkpoint);
  assert.equal(v6.state.name, 'Lighthouse, edited before publishing');
  assert.equal(v6.current, true, JSON.stringify(v6.report.reasons));
  assert.deepEqual(v6.report.identityEvidence.editors.map((e) => [e.did, e.status]), [[bob.did, 'complete']]);
  const placed = [v6.report.anchoring!.anchor!, ...v6.report.anchoring!.accepted];
  assert.deepEqual(placed.map((a) => a.versionId), [anchored2.original.checkpoint, early.original.checkpoint, bobAfter.original.checkpoint]);
  assert.ok(placed.every((a, i) => i === 0 || a.height > placed[i - 1].height), 'one accepted entry per later block (P9.13)');
  evidence.beforeAnchor = {
    did: did2, sat: sat2, editor: bob.did, refusedWithoutEditorHistory: refusedWithoutBob,
    anchor: { versionId: anchored2.original.checkpoint, carries: anchor2Pair.carries, commitTxId: anchor2Pair.prepared.commitTxId, revealTxId: anchor2Pair.prepared.revealTxId, inscription: anchor2Pair.prepared.inscriptionId, bodyBytes: anchorOnOrd.body.bytes.length, height: placed[0].height },
    edit: { versionId: early.original.checkpoint, inscription: early2Pair.prepared.inscriptionId, height: placed[1].height },
    editorEntry: { versionId: bobAfter.original.checkpoint, signer: bob.did, inscription: bob2Pair.prepared.inscriptionId, height: placed[2].height },
    publication: [first2.pending.publication, waiting2a.pending.publication, second2.pending.publication],
    offChain: anchor2Pair.offChain, actions: actions.splice(0), head: v6.head, current: v6.current,
  };

  step('9: fresh readers from Bitcoin alone, and a transfer handoff');
  // 9. No copy of either log: each sat carries its Original's whole log (P9.17). The off-chain
  //    signer DID histories are the only other input (P9.18).
  const fromBitcoin = async (satAlias: string, authors: AuthorDidEvidence[]) =>
    verifyOriginal({ bitcoin: [(await readSat(satAlias)).evidence], authors, now: Date.now() });
  const alone1 = await fromBitcoin(satDid, [alice.evidence]);
  assert.equal(alone1.anchoring?.status, 'anchored');
  assert.equal(alone1.anchoring?.copy, 'absent');
  assert.equal(alone1.head, v5.head);
  assert.equal(alone1.history.status, 'valid');
  assert.equal(alone1.authorBinding.status, 'valid');
  assert.equal(alone1.identityEvidence.status, 'complete');
  assert.equal(alone1.resources.status, 'partial', 'resource bytes are not on Bitcoin: unavailable, not a failure (P9.18)');
  const alone2 = await fromBitcoin(sat2, [alice.evidence, bob.evidence]);
  assert.equal(alone2.anchoring?.status, 'anchored');
  assert.equal(alone2.head, bobAfter.original.checkpoint);
  assert.equal(alone2.identityEvidence.status, 'complete');
  assert.deepEqual(alone2.identityEvidence.editors.map((e) => e.did), [bob.did]);
  const withoutBob = await fromBitcoin(sat2, [alice.evidence]);
  assert.equal(withoutBob.identityEvidence.status, 'incomplete', 'without the editor\'s did:vh history, identity evidence is incomplete (P9.18)');
  assert.equal(withoutBob.current, false);
  // The sat's next holder: the sender hands over what it holds; an empty SDK verifies it against the sat.
  // Through the head Bitcoin accepts (the default).
  const handoff = await transferHandoff(sdk, did2, { provider, clock, index: ORD });
  const recipient = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
  const received = await verifyHandoff(recipient, handoff.package.bytes, { provider, clock, index: ORD, expectedSat: sat2 });
  assert.equal(received.report.anchoring?.status, 'anchored');
  assert.equal(received.report.head, bobAfter.original.checkpoint);
  assert.equal(received.report.history.status, 'valid');
  assert.equal(received.report.identityEvidence.status, 'complete');
  assert.equal(received.report.resources.status, 'available');
  evidence.freshReaders = {
    fromBitcoinAlone: [
      { sat: satDid, head: alone1.head, copy: alone1.anchoring?.copy, history: alone1.history.status, identity: alone1.identityEvidence.status, resources: alone1.resources.status, accepted: alone1.anchoring?.accepted.length },
      { sat: sat2, head: alone2.head, copy: alone2.anchoring?.copy, history: alone2.history.status, identity: alone2.identityEvidence.status, editors: alone2.identityEvidence.editors.map((e) => e.did) },
    ],
    withoutEditorHistory: { identity: withoutBob.identityEvidence.status, current: withoutBob.current },
    handoff: {
      completeness: handoff.package.manifest.completeness, identities: handoff.offChain.identities, resources: handoff.offChain.resources.length,
      recipient: { anchoring: received.report.anchoring?.status, head: received.report.head, identity: received.report.identityEvidence.status, resources: received.report.resources.status, reasons: received.reasons },
    },
  };

  evidence.result = 'passed';
  const summary = JSON.stringify(evidence, null, 2);
  console.log(summary);
  if (process.env.ORIGINALS_REGTEST_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_EVIDENCE, summary);
} finally {
  await env.stop();
}
