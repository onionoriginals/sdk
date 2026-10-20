/**
 * Anchored Originals on real Bitcoin Core 31.1 and ord 0.29.0, regtest only
 * (plan 011 PR 10; plan 012). Nothing here touches mainnet or testnet.
 *
 * The journey, each step asserted:
 *  1. A local Original is anchored to a sat its writer holds; the anchoring
 *     entry is inscribed on that sat. Broadcast but unmined, it does not
 *     count (P9.4); mined, the Original verifies as anchored and current,
 *     with provisional ownership of the reveal output (P9.11, P9.16).
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
 *  8. An edit committed before the anchoring entry is published: catching up
 *     inscribes the anchoring entry first, then the edit, on a second sat.
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
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, keySigner } from '../../packages/sdk/src/originals/index';
import { catchUp, prepareEntryInscription, readAnchored, resumeInscriptionOnSat, submitPreparedInscriptionOnSat, type CatchUpStep } from '../../packages/sdk/src/originals/bitcoin-writer';
import type { OriginalView } from '../../packages/sdk/src/originals/index';
import { startRegtest } from './environment';

const random32 = () => crypto.getRandomValues(new Uint8Array(32));
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
  };
  const clock = new InscriptionClock(async (height) => {
    const hash = await env.rpc<string>('getblockhash', [height]);
    return { time: (await env.rpc<{ time: number }>('getblockheader', [hash])).time, hash };
  });

  // The author: a did:vh with one Originals key, separate from its update key (P5.11).
  const update = localSigner('Ed25519', random32());
  const originalsKey = random32();
  const originalsPub = localSigner('Ed25519', originalsKey).publicKeyMultibase;
  const k = update.publicKeyMultibase;
  const authorGenesis = await createLog({
    versionTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#orig', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: originalsPub }],
      assertionMethod: ['did:vh:{SCID}#orig'],
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  const authorDid = authorGenesis.state.id as string;
  const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: authorGenesis.versionId };
  const signer = keySigner({ keyType: 'Ed25519', secretKey: originalsKey, verificationMethod: author.verificationMethod });
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [{ did: authorDid, log: serializeLog([authorGenesis]) }], freshness: 'asserted' });

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

  const anchorPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [satUtxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal(anchorPair.versionId, anchored.original.checkpoint);
  const sent = await submitPreparedInscriptionOnSat({ prepared: anchorPair.prepared, provider, recoveryStore });
  assert.equal(sent.broadcast, 'reveal_broadcast');
  const pending = await readAnchored(sdk, did, { provider, clock });
  assert.notEqual(pending.report.anchoring?.status, 'anchored', 'a broadcast, unmined inscription must not count (P9.4)');
  assert.equal(pending.current, false);
  await env.mine();
  const v1 = await readAnchored(sdk, did, { provider, clock });
  assert.equal(v1.report.anchoring?.status, 'anchored');
  assert.equal(v1.head, anchored.original.checkpoint);
  assert.equal(v1.report.ordering, 'anchored');
  assert.equal(v1.report.ownership?.output, `${anchorPair.prepared.revealTxId}:0`);
  assert.equal(v1.current, true, JSON.stringify(v1.report.reasons));
  evidence.anchor = { did, sat: satDid, inscription: anchorPair.prepared.inscriptionId, height: v1.report.anchoring?.anchor?.height, ownership: v1.report.ownership };

  step('2: reinscribe');
  // 2. Edit, and reinscribe on the same sat by spending the output that holds it.
  const edit = await sdk.edit(did, { parent: v1.checkpoint, name: 'Harbor at dawn, on Bitcoin', author, signer });
  const holding = await outputOf(anchorPair.prepared.revealTxId, 0);
  const editPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [holding, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal((await submitPreparedInscriptionOnSat({ prepared: editPair.prepared, provider, recoveryStore })).broadcast, 'reveal_broadcast');
  const editBlock = (await env.mine())[0];
  const v2 = await readAnchored(sdk, did, { provider, clock });
  assert.equal(v2.head, edit.original.checkpoint);
  assert.equal(v2.state.name, 'Harbor at dawn, on Bitcoin');
  assert.equal(v2.report.anchoring?.accepted.length, 1);
  assert.equal(v2.current, true, JSON.stringify(v2.report.reasons));
  evidence.edit = { inscription: editPair.prepared.inscriptionId, block: editBlock, ownership: v2.report.ownership };

  step('3: already inscribed');
  // 3. The head Bitcoin already shows is not inscribed again (P9.13).
  await assert.rejects(
    prepareEntryInscription({ sdk, did, versionId: edit.original.checkpoint, fundingUtxos: [await outputOf(editPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock }),
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
  const reorged = await readAnchored(sdk, did, { provider, clock });
  assert.equal(reorged.head, anchored.original.checkpoint);
  assert.ok(reorged.report.reasons.includes('authoritative-source-changed'), JSON.stringify(reorged.report.reasons));
  assert.equal(reorged.current, false);
  const reincluded = (await env.mine())[0];
  const restored = await readAnchored(sdk, did, { provider, clock });
  assert.equal(restored.head, edit.original.checkpoint);
  assert.equal(restored.current, true, JSON.stringify(restored.report.reasons));
  evidence.reorg = { invalidated: editBlock, replacement: replacement.hash, reported: reorged.report.reasons.filter((r) => r === 'authoritative-source-changed'), reincludedIn: reincluded, restoredHead: restored.head };

  step('5: crash and resume');
  // 5. A crash after the commit broadcast: the record survives, resume sends the same pair.
  const third = await sdk.edit(did, { parent: restored.checkpoint, name: 'Harbor at dusk', author, signer });
  // A pair whose first funding UTXO holds another sat is refused, so only the holder extends it.
  await assert.rejects(
    prepareEntryInscription({ sdk, did, fundingUtxos: [await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock }),
    (error: unknown) => (error as { code?: string }).code === 'WRONG_SAT',
  );
  const thirdPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [await outputOf(editPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  const crashing = Object.create(provider) as RegtestProvider;
  crashing.broadcastTransaction = (raw: unknown) => (raw === thirdPair.prepared.revealTxHex ? Promise.reject(new Error('process died before the reveal')) : provider.broadcastTransaction(raw));
  const crashed = await submitPreparedInscriptionOnSat({ prepared: thirdPair.prepared, provider: crashing, recoveryStore }).catch((error: unknown) => ({ error }));
  const stored = records.get(thirdPair.prepared.commitTxId);
  assert.ok(stored && stored.broadcast !== 'reveal_broadcast', `the record shows the reveal unsent: ${stored?.broadcast}`);
  await assert.rejects(env.rpc('getmempoolentry', [thirdPair.prepared.revealTxId]), 'the reveal never reached the node');
  await env.mine();
  assert.equal((await provider.getTransactionStatus(thirdPair.prepared.commitTxId)).confirmed, true, 'the commit is mined');
  assert.equal((await provider.getTransactionStatus(thirdPair.prepared.revealTxId)).confirmed, false, 'the reveal is not');
  const midway = await readAnchored(sdk, did, { provider, clock });
  assert.equal(midway.head, edit.original.checkpoint, 'a commit without its reveal never advances the boundary (P9.4)');
  const resumed = await resumeInscriptionOnSat({ recoveryId: thirdPair.prepared.commitTxId, provider, recoveryStore });
  assert.equal(resumed.revealTxId, thirdPair.prepared.revealTxId, 'resume rebroadcasts the same pair (P9.6)');
  await env.mine();
  const v3 = await readAnchored(sdk, did, { provider, clock });
  assert.equal(v3.head, third.original.checkpoint);
  assert.equal(v3.report.anchoring?.accepted.at(-1)?.inscription, thirdPair.prepared.inscriptionId, 'the resumed pair is the one Bitcoin shows');
  assert.equal(v3.current, true, JSON.stringify(v3.report.reasons));
  evidence.retry = { crashed: 'error' in (crashed as object) ? String((crashed as { error: unknown }).error) : (crashed as { broadcast: string }).broadcast, recordState: stored?.broadcast, resumed: resumed.broadcast, head: v3.head };

  step('6: uninscribed entry');
  // 6. An entry the author signs but nobody inscribes is never current.
  const local = await sdk.edit(did, { parent: v3.checkpoint, name: 'Only in a local copy', author, signer });
  const v4 = await readAnchored(sdk, did, { provider, clock });
  assert.equal(v4.head, third.original.checkpoint);
  assert.equal(v4.report.anchoring?.superseded, 1);
  assert.notEqual(v4.head, local.original.checkpoint);
  // An entry after it cannot be inscribed first: Bitcoin would never accept it (P9.13).
  const skips = await sdk.edit(did, { parent: local.original.checkpoint, name: 'Skips one', author, signer });
  await assert.rejects(
    prepareEntryInscription({ sdk, did, versionId: skips.original.checkpoint, fundingUtxos: [await outputOf(thirdPair.prepared.revealTxId, 0), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock }),
    (error: unknown) => (error as { code?: string }).code === 'HEAD_NOT_NEXT',
  );
  evidence.uninscribed = { signed: local.original.checkpoint, head: v4.head, superseded: v4.report.anchoring?.superseded, skipRefused: 'HEAD_NOT_NEXT' };

  step('7: catch up');
  // 7. Publish the uninscribed entries one block at a time from the recovery store and a fresh read.
  const holdingOf = async (view: OriginalView) => {
    const [txid, vout] = view.report.ownership!.output.split(':');
    return outputOf(txid, Number(vout));
  };
  const plan = (of: string) => catchUp({ sdk, did: of, provider, clock, recoveryStore, recoveryIds: [...records.keys()] });
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
  const catch1 = await prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(start.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal(catch1.versionId, local.original.checkpoint);
  assert.equal(catch1.remaining, 1);
  // The process dies after the commit broadcast, before the reveal.
  const crashing1 = Object.create(provider) as RegtestProvider;
  crashing1.broadcastTransaction = (raw: unknown) => (raw === catch1.prepared.revealTxHex ? Promise.reject(new Error('process died before the reveal')) : provider.broadcastTransaction(raw));
  await submitPreparedInscriptionOnSat({ prepared: catch1.prepared, provider: crashing1, recoveryStore }).catch(() => undefined);
  const resume1 = await expectStep(did, 'resume', local.original.checkpoint);
  assert.equal(resume1.recoveryId, catch1.prepared.commitTxId, 'the recorded pair is resumed, not a new one prepared (P9.6)');
  const resumedCatch = await resumeInscriptionOnSat({ recoveryId: resume1.recoveryId, provider, recoveryStore });
  assert.equal(resumedCatch.revealTxId, catch1.prepared.revealTxId);
  const waiting1 = await expectStep(did, 'wait-for-confirmation', local.original.checkpoint);
  assert.equal(waiting1.recoveryId, catch1.prepared.commitTxId, 'a pending reveal is waited on, never prepared twice');
  const catchBlock1 = (await env.mine())[0];
  const after1 = await expectStep(did, 'prepare', skips.original.checkpoint);
  assert.equal(after1.pending.accepted, local.original.checkpoint, 'the accepted head is re-read before advancing');
  assert.deepEqual(after1.replaces, []);
  const catch2 = await prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(after1.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal(catch2.versionId, skips.original.checkpoint);
  assert.equal((await submitPreparedInscriptionOnSat({ prepared: catch2.prepared, provider, recoveryStore })).broadcast, 'reveal_broadcast');
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
    prepareEntryInscription({ sdk, did, fundingUtxos: [await holdingOf(v5), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock }),
    (error: unknown) => (error as { code?: string }).code === 'NOTHING_TO_INSCRIBE',
  );
  evidence.catchUp = {
    queue: start.pending.queue, actions: actions.splice(0),
    crashedAfterCommit: catch1.prepared.commitTxId, resumedReveal: resumedCatch.revealTxId,
    published: tail.map((a) => ({ versionId: a.versionId, inscription: a.inscription, height: a.height })),
    blocks: [catchBlock1, catchBlock2], head: v5.head, current: v5.current,
  };

  step('8: edits before the anchor is published');
  // 8. A second Original, edited before its anchoring entry reaches Bitcoin: the anchoring entry goes first.
  const lighthouse = await sdk.create({ name: 'Lighthouse', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes: new TextEncoder().encode('regtest lighthouse') }], author, signer });
  if (lighthouse.kind !== 'original') throw new Error('expected an Original');
  const did2 = lighthouse.original.did;
  const sat2Utxo = await fundUtxo(0.001);
  const sat2 = btcoAlias('regtest', await provider.getFirstSatOfOutput!(sat2Utxo));
  const anchored2 = await sdk.anchor(did2, { parent: lighthouse.original.checkpoint, author, signer, sat: sat2 });
  const early = await sdk.edit(did2, { parent: anchored2.original.checkpoint, name: 'Lighthouse, edited before publishing', author, signer });
  const first2 = await expectStep(did2, 'prepare', anchored2.original.checkpoint);
  assert.equal(first2.pending.accepted, null);
  assert.deepEqual(first2.pending.queue, [anchored2.original.checkpoint, early.original.checkpoint]);
  await assert.rejects(
    prepareEntryInscription({ sdk, did: did2, versionId: early.original.checkpoint, fundingUtxos: [sat2Utxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock }),
    (error: unknown) => (error as { code?: string }).code === 'HEAD_NOT_NEXT',
  );
  const anchor2Pair = await prepareEntryInscription({ sdk, did: did2, fundingUtxos: [sat2Utxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal(anchor2Pair.versionId, anchored2.original.checkpoint);
  assert.equal((await submitPreparedInscriptionOnSat({ prepared: anchor2Pair.prepared, provider, recoveryStore })).broadcast, 'reveal_broadcast');
  await expectStep(did2, 'wait-for-confirmation', anchored2.original.checkpoint);
  await env.mine();
  const second2 = await expectStep(did2, 'prepare', early.original.checkpoint);
  assert.equal(second2.pending.accepted, anchored2.original.checkpoint);
  const early2Pair = await prepareEntryInscription({ sdk, did: did2, fundingUtxos: [await holdingOf(second2.pending.view), await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock });
  assert.equal((await submitPreparedInscriptionOnSat({ prepared: early2Pair.prepared, provider, recoveryStore })).broadcast, 'reveal_broadcast');
  await env.mine();
  const done2 = await expectStep(did2, 'done');
  const v6 = done2.pending.view;
  assert.equal(v6.head, early.original.checkpoint);
  assert.equal(v6.state.name, 'Lighthouse, edited before publishing');
  assert.equal(v6.current, true, JSON.stringify(v6.report.reasons));
  assert.ok(v6.report.anchoring!.accepted[0].height > v6.report.anchoring!.anchor!.height);
  evidence.beforeAnchor = {
    did: did2, sat: sat2,
    anchor: { versionId: anchored2.original.checkpoint, inscription: anchor2Pair.prepared.inscriptionId, height: v6.report.anchoring!.anchor!.height },
    edit: { versionId: early.original.checkpoint, inscription: early2Pair.prepared.inscriptionId, height: v6.report.anchoring!.accepted[0].height },
    actions: actions.splice(0), head: v6.head, current: v6.current,
  };

  evidence.result = 'passed';
  const summary = JSON.stringify(evidence, null, 2);
  console.log(summary);
  if (process.env.ORIGINALS_REGTEST_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_EVIDENCE, summary);
} finally {
  await env.stop();
}
