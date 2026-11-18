/**
 * Bitcoin previews on real Bitcoin Core 31.1 and ord 0.29.0, regtest only
 * (plan 011 phase 12b; originals-spec PR 64: P9.17, P9.18, P9.30, P14.12).
 * Nothing here touches mainnet or testnet.
 *
 * The journey, each step asserted on real transactions and on what ord serves:
 *  1. An image Original (a 640×480 PNG) is anchored. The anchoring entry names
 *     a generated WebP preview of at most 8,192 bytes, and the anchoring
 *     inscription's body is exactly that preview under `image/webp`; the
 *     notice says a preview is inscribed, the version stays off Bitcoin, and
 *     what the pair costs. Mined, the Original is anchored and current.
 *  2. A name-only edit keeps the preview: its inscription carries the same
 *     preview again.
 *  3. A new image version names a new preview, which its inscription carries.
 *  4. A name-only edit with `body: "full"` names no preview, and its
 *     inscription carries the full version (a 160×120 PNG).
 *  5. A text Original with no preview: its anchoring inscription has no body
 *     at all (no ord body push, no content type). ord 0.29.0 indexes it as an
 *     inscription with a null content length and serves its metadata, the
 *     entries. A new version with the author's own `text/plain` preview is
 *     then inscribed with that preview as its body.
 *  6. Fresh readers, with only the sats and the author's DID history: both
 *     Originals verify as anchored and current; each accepted inscription
 *     reports its body (preview, version or none); the version inscribed in
 *     full is verified from Bitcoin, and every version known only by its
 *     preview is unavailable, never verified by the preview.
 *
 * Writes a JSON evidence summary to stdout (and to
 * $ORIGINALS_REGTEST_PREVIEW_EVIDENCE when set).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import { decodeCbor, resourceDigest, verifyOriginal, type AuthorDidEvidence } from '@originals/vh/originals';
import { RegtestProvider } from '../../packages/sdk/src/adapters/providers/RegtestProvider';
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore } from '../../packages/sdk/src/bitcoin/inscription-recovery';
import type { BitcoinSigner } from '../../packages/sdk/src/types/common';
import type { Utxo } from '../../packages/sdk/src/types/bitcoin';
import { InscriptionClock, MemoryStore, OriginalsSDK, PREVIEW_MAX_BYTES, btcoAlias, keySigner, satEvidence } from '../../packages/sdk/src/originals/index';
import { prepareEntryInscription, readAnchored, submitEntryInscription, type EntryInscriptionParams, type PreparedEntryInscription } from '../../packages/sdk/src/originals/bitcoin-writer';
import { busy, png } from '../../packages/sdk/tests/unit/originals/preview-fixtures';
import { startRegtest } from './environment';

const ORD = 'ord-0.29.0-regtest';
const evidence: Record<string, unknown> = {};
const step = (label: string) => console.error(`[originals-preview] ${label}`);
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

step('starting Bitcoin Core and ord');
const env = await startRegtest({ indexAddresses: true, ...(process.env.ORIGINALS_REGTEST_LOGS ? { logsDir: process.env.ORIGINALS_REGTEST_LOGS } : {}) });
try {
  evidence.versions = env.versions;
  const provider = new RegtestProvider(env);
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
    const header = await env.rpc<{ time: number; previousblockhash?: string }>('getblockheader', [hash]);
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  });

  // Alice: a did:vh with one Originals key, separate from its update key (P5.11).
  const update = random32();
  const signingKey = random32();
  const k = localSigner('Ed25519', update).publicKeyMultibase;
  const aliceLog = await createLog({
    versionTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#orig', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: localSigner('Ed25519', signingKey).publicKeyMultibase }],
      assertionMethod: ['did:vh:{SCID}#orig'],
    },
    sign: signWith(localSigner('Ed25519', update), { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  const aliceDid = aliceLog.state.id as string;
  const author = { did: aliceDid, verificationMethod: `${aliceDid}#orig`, versionId: aliceLog.versionId };
  const aliceEvidence: AuthorDidEvidence = { did: aliceDid, log: serializeLog([aliceLog]) };
  const signer = keySigner({ keyType: 'Ed25519', secretKey: signingKey, verificationMethod: author.verificationMethod });
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [aliceEvidence] });

  /** What ord serves for an inscription: its JSON, and its content (null for none). */
  const ordInscription = async (id: string) => {
    const info = await (await fetch(`${env.ordUrl}/inscription/${id}`, { headers: { accept: 'application/json' } })).json() as { content_type: string | null; content_length: number | null; sat: number };
    const content = await fetch(`${env.ordUrl}/content/${id}`);
    const metadata = await (await fetch(`${env.ordUrl}/r/metadata/${id}`, { headers: { accept: 'application/json' } })).json() as string | null;
    return { info, contentStatus: content.status, content: content.ok ? new Uint8Array(await content.arrayBuffer()) : null, metadata: metadata === null ? null : Uint8Array.from(Buffer.from(metadata, 'hex')) };
  };
  const satOf = (alias: string) => alias.split(':').at(-1)!;
  /** Prepare, check the notice, send, mine and read back; returns the pair and ord's view of it. */
  const inscribe = async (did: string, holding: Utxo, extra: Partial<EntryInscriptionParams> = {}) => {
    const pair = await prepareEntryInscription({ sdk, did, fundingUtxos: [holding, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 1, network: 'regtest', provider, clock, index: ORD, recoveryStore, ...extra });
    assert.equal(pair.notice.permanent, true);
    assert.equal(pair.cost.total, pair.cost.commitFee + pair.cost.revealFee);
    assert.ok(pair.notice.text.includes(`${pair.cost.total} sats`), 'the notice says the cost (P9.18)');
    const sent = await submitEntryInscription({ sdk, did, pair, provider, clock, index: ORD, recoveryStore });
    assert.equal(sent.broadcast, 'reveal_broadcast');
    await env.mine();
    return { pair, ord: await ordInscription(pair.prepared.inscriptionId) };
  };
  const summary = (p: PreparedEntryInscription, ord: Awaited<ReturnType<typeof ordInscription>>) => ({
    versionId: p.versionId, inscription: p.prepared.inscriptionId, commitTxId: p.prepared.commitTxId, revealTxId: p.prepared.revealTxId,
    body: p.body, contentType: ord.info.content_type, contentLength: ord.info.content_length, cost: p.cost,
  });

  step('1: anchor an image with a preview');
  const v1 = png(busy(640, 480, 12));
  const created = await sdk.create({ name: 'Harbor at dawn', resource: { mediaType: 'image/png', bytes: v1 }, author, signer });
  assert.equal(created.kind, 'original');
  if (created.kind !== 'original') throw new Error('unreachable');
  const did = created.original.did;
  const satUtxo = await fundUtxo(0.001);
  const satAlias = btcoAlias('regtest', await provider.getFirstSatOfOutput!(satUtxo));
  const anchored = await sdk.anchor(did, { parent: created.original.checkpoint, author, signer, sat: satAlias });
  assert.equal(anchored.preview?.status, 'generated', anchored.preview?.message ?? 'no preview report');
  const p1 = anchored.original.state.preview!;
  assert.equal(p1.mediaType, 'image/webp');
  assert.ok(p1.size >= 1 && p1.size <= PREVIEW_MAX_BYTES);
  const a = await inscribe(did, satUtxo);
  assert.equal(a.pair.body, 'preview');
  assert.equal(a.pair.notice.body.kind, 'preview');
  assert.ok(a.pair.notice.text.includes('not on Bitcoin'));
  assert.equal(a.ord.info.content_type, 'image/webp', 'ord serves the preview under image/webp (P14.12)');
  assert.equal(a.ord.info.content_length, p1.size);
  assert.ok(a.ord.content && resourceDigest(a.ord.content) === p1.digest, 'the body is exactly the named preview (P9.17)');
  assert.equal(new TextDecoder().decode(a.ord.content!.subarray(8, 12)), 'WEBP');
  assert.deepEqual((decodeCbor(a.ord.metadata!) as Array<{ versionId: string }>).map((e) => e.versionId), a.pair.carries);
  const read1 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(read1.report.anchoring?.status, 'anchored');
  assert.equal(read1.report.anchoring?.anchor?.body, 'preview');
  assert.equal(read1.current, true, JSON.stringify(read1.report.reasons));
  evidence.anchor = { did, sat: satAlias, preview: p1, generated: anchored.preview?.generated, versionBytes: v1.length, ...summary(a.pair, a.ord) };

  step('2: name-only edit, preview kept');
  const renamed = await sdk.edit(did, { parent: read1.checkpoint, name: 'Harbor at dawn, on Bitcoin', author, signer });
  assert.equal(renamed.preview?.status, 'kept');
  assert.deepEqual(renamed.original.state.preview, p1);
  const b = await inscribe(did, await outputOf(a.pair.prepared.revealTxId, 0));
  assert.equal(b.pair.body, 'preview');
  assert.ok(b.ord.content && resourceDigest(b.ord.content) === p1.digest, 'the same preview again (P9.30)');
  evidence.rename = summary(b.pair, b.ord);

  step('3: a new image version, a new preview');
  const v2 = png(busy(160, 120, 13));
  const recut = await sdk.edit(did, { parent: renamed.original.checkpoint, resource: { bytes: v2 }, author, signer });
  assert.equal(recut.preview?.status, 'generated');
  const p2 = recut.original.state.preview!;
  assert.notEqual(p2.digest, p1.digest);
  const c = await inscribe(did, await outputOf(b.pair.prepared.revealTxId, 0));
  assert.ok(c.ord.content && resourceDigest(c.ord.content) === p2.digest, 'the new preview (P9.30)');
  evidence.newVersion = { preview: p2, versionBytes: v2.length, ...summary(c.pair, c.ord) };

  step('4: the full version');
  const full = await sdk.edit(did, { parent: recut.original.checkpoint, name: 'Harbor at dusk', author, signer, body: 'full' });
  assert.equal(full.preview?.reason, 'full-version-chosen');
  assert.equal(full.original.state.preview, undefined);
  const d = await inscribe(did, await outputOf(c.pair.prepared.revealTxId, 0), { body: 'full' });
  assert.equal(d.pair.body, 'full');
  assert.equal(d.ord.info.content_type, 'image/png');
  assert.ok(d.ord.content && hex(d.ord.content) === hex(v2), 'the full version (P9.17)');
  const read4 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.deepEqual(read4.report.anchoring?.accepted.map((p) => p.body), ['preview', 'preview', 'version']);
  assert.equal(read4.head, full.original.checkpoint);
  evidence.full = summary(d.pair, d.ord);

  step('5: a text Original with no preview: no body');
  const text = new TextEncoder().encode('# Harbor\n\nA note on the harbor at dawn.\n');
  const note = await sdk.create({ name: 'Harbor notes', resource: { mediaType: 'text/markdown', bytes: text }, author, signer });
  if (note.kind !== 'original') throw new Error('unreachable');
  const sat2Utxo = await fundUtxo(0.001);
  const sat2 = btcoAlias('regtest', await provider.getFirstSatOfOutput!(sat2Utxo));
  const noteAnchored = await sdk.anchor(note.original.did, { parent: note.original.checkpoint, author, signer, sat: sat2 });
  assert.equal(noteAnchored.preview?.reason, 'not-an-image');
  const e = await inscribe(note.original.did, sat2Utxo);
  assert.equal(e.pair.body, 'none');
  assert.equal(e.pair.notice.body.kind, 'none');
  assert.equal(e.ord.info.content_length, null, 'ord 0.29.0 indexes an inscription with no body: null content length (P14.12)');
  assert.equal(e.ord.info.content_type, null, 'and no content type');
  assert.equal(e.ord.contentStatus, 404, 'it serves no content');
  assert.deepEqual((decodeCbor(e.ord.metadata!) as Array<{ versionId: string }>).map((x) => x.versionId), e.pair.carries, 'and serves its metadata: the entries (P9.17)');
  assert.equal(String(e.ord.info.sat), satOf(sat2));
  const snap = await provider.getSatSnapshot!(satOf(sat2), { bodies: 'originals' });
  const noBodyRead = snap.publications.find((p) => p.id === e.pair.prepared.inscriptionId)!.body;
  assert.ok(noBodyRead.status === 'complete' && noBodyRead.noBody === true, 'the sat reader reports no body');
  const read5 = await readAnchored(sdk, note.original.did, { provider, clock, index: ORD });
  assert.equal(read5.report.anchoring?.anchor?.body, 'none');
  assert.equal(read5.current, true, JSON.stringify(read5.report.reasons));
  // The author's own preview of a new text version.
  const text2 = new TextEncoder().encode('# Harbor\n\nA longer note on the harbor at dawn, revised.\n');
  const noteV2 = await sdk.edit(note.original.did, { parent: read5.checkpoint, resource: { bytes: text2 }, author, signer, preview: { bytes: new TextEncoder().encode('A note on the harbor.'), mediaType: 'text/plain' } });
  assert.equal(noteV2.preview?.status, 'supplied');
  const f = await inscribe(note.original.did, await outputOf(e.pair.prepared.revealTxId, 0));
  assert.equal(f.ord.info.content_type, 'text/plain');
  assert.equal(new TextDecoder().decode(f.ord.content!), 'A note on the harbor.');
  evidence.noBody = { did: note.original.did, sat: sat2, ...summary(e.pair, e.ord), ordContentStatus: e.ord.contentStatus, readerNoBody: true };
  evidence.authorPreview = { preview: noteV2.original.state.preview, ...summary(f.pair, f.ord) };

  step('6: fresh readers');
  const readerOf = async (alias: string) => {
    const snapshot = await provider.getSatSnapshot!(satOf(alias), { bodies: 'originals' });
    const satpoint = snapshot.ownership.satpoint!;
    const ownerConfirmations = (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0;
    return verifyOriginal({ bitcoin: [await satEvidence(snapshot, { clock, ownerConfirmations, index: ORD })], authors: [aliceEvidence], now: Date.now() });
  };
  const image = await readerOf(satAlias);
  assert.equal(image.anchoring?.status, 'anchored');
  assert.equal(image.history.status, 'valid');
  assert.equal(image.head, full.original.checkpoint);
  assert.equal(image.current, true, JSON.stringify(image.reasons));
  assert.deepEqual(image.resources.versions.map((v) => [v.version, v.bytes, v.onBitcoin]), [[1, 'missing', false], [2, 'verified', true]],
    'v1 is known only by its preview: unavailable, never verified by it; v2 was inscribed in full (P9.17, P9.30, P7.4)');
  const notes = await readerOf(sat2);
  assert.equal(notes.anchoring?.status, 'anchored');
  assert.equal(notes.current, true, JSON.stringify(notes.reasons));
  assert.deepEqual(notes.anchoring?.accepted.map((p) => p.body), ['preview']);
  assert.equal(notes.anchoring?.anchor?.body, 'none');
  assert.deepEqual(notes.resources.versions.map((v) => v.bytes), ['missing', 'missing']);
  evidence.freshReaders = {
    image: { head: image.head, current: image.current, bodies: [image.anchoring?.anchor?.body, ...(image.anchoring?.accepted.map((p) => p.body) ?? [])], resources: image.resources.versions.map((v) => ({ version: v.version, bytes: v.bytes, onBitcoin: v.onBitcoin })) },
    notes: { head: notes.head, current: notes.current, bodies: [notes.anchoring?.anchor?.body, ...(notes.anchoring?.accepted.map((p) => p.body) ?? [])], resources: notes.resources.versions.map((v) => ({ version: v.version, bytes: v.bytes })) },
  };

  const out = JSON.stringify({ journey: 'originals-preview', network: 'regtest', ...evidence }, null, 2);
  console.log(out);
  if (process.env.ORIGINALS_REGTEST_PREVIEW_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_PREVIEW_EVIDENCE, out);
  step('done');
} finally {
  await env.stop();
}
