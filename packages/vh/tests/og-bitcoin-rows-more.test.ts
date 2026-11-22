// More §9 rows on Bitcoin (P9.15, P9.16, P9.17, P9.30, P9.31, P9.36): bodies after the anchor,
// competing anchors, the P9.15 table's rows for unverifiable and mismatched signer versions.
import { describe, expect, test } from 'bun:test';
import { buildPublication, encodeEnvelope, encodeMetadata, resourceDigest, verifyOriginal, type OgEntry } from '../src/og/index.js';
import { anchoring, Chain, history } from './helpers/og-chain.js';
import { seeded, WebvhAuthor } from './helpers/originals.js';
import { axes, enc, labelOf, res, webvhSigner, World, type Signer } from './helpers/og-world.js';
import { withSatRead, bitcoinEvidence } from './helpers/og-vectors.js';

const SAT = 'did:btco:reg:5000';
const SAT2 = 'did:btco:reg:6000';
const EDITOR_SAT = 'did:btco:reg:888';
const web = (w: World) => w.author.handle as WebvhAuthor;
const later = (w: World, parent: OgEntry, change: (s: any) => void, opts: Parameters<World['entry']>[1] = {}) => w.entry((s) => { change(s); }, { parent, push: false, ...opts });
const pub1 = (e: OgEntry, signers?: ReturnType<typeof history>[], body: Uint8Array | null = null) => buildPublication({ entries: [e], signers, body });
const PRV = enc('PRV');
const preview = (b: Uint8Array) => ({ mediaType: 'image/webp', size: b.length, digest: resourceDigest(b) });

async function anchoredWorld(body: 'none' | 'full' | 'preview' = 'none', sat = SAT) {
  const w = await World.create();
  const before = await w.entry((s) => { s.asset.name = 'Two'; });
  const anchor = await w.entry((s) => { s.asset.aliases = [sat]; s.asset.body = body; if (body === 'preview') s.asset.preview = preview(PRV); });
  const chain = new Chain();
  chain.publish(sat, anchoring(w, { body: body === 'full' ? res('version 1') : body === 'preview' ? PRV : null }));
  return { w, before, anchor, chain };
}

/** A did:btco editor whose DID document is inscribed on its own sat. */
function btcoEditor(chain: Chain, opts: { unreadBefore?: boolean } = {}) {
  const ke = seeded(240);
  if (opts.unreadBefore) chain.unread(EDITOR_SAT);
  const v1 = chain.btcoVersion(EDITOR_SAT, { id: EDITOR_SAT, verificationMethod: [{ id: `${EDITOR_SAT}#key-1`, type: 'Multikey', controller: EDITOR_SAT, publicKeyMultibase: ke.publicKeyMultibase }], assertionMethod: [`${EDITOR_SAT}#key-1`] });
  const editor: Signer = { did: EDITOR_SAT, key: ke, kind: 'webvh', handle: null as never, log: () => '', ref: (f = 'key-1', v = v1) => ({ did: EDITOR_SAT, verificationMethod: `${EDITOR_SAT}#${f}`, versionId: v }) };
  return { editor, v1 };
}

describe('bodies after the anchor (P9.17, P9.30)', () => {
  test('T9-084: a name change after the anchor whose parent names a preview carries it; the body is that preview again', async () => {
    const { w, anchor, chain } = await anchoredWorld('preview');
    const e = await later(w, anchor, (s) => { s.asset.name = 'Renamed'; });
    chain.publish(SAT, pub1(e, undefined, PRV));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'accepted' });
    // Or it carries none, with no body.
    const { w: w2, anchor: a2, chain: c2 } = await anchoredWorld('preview');
    const none = await later(w2, a2, (s) => { s.asset.name = 'Renamed'; delete s.asset.preview; s.asset.body = 'none'; });
    c2.publish(SAT, pub1(none));
    expect(labelOf(await verifyOriginal(c2.evidence(w2.did)), none)).toMatchObject({ status: 'accepted' });
  });

  test('T9-085: a name change after the anchor whose parent names no preview: the full version again, or no body', async () => {
    const { w, anchor, chain } = await anchoredWorld('full');
    const e = await later(w, anchor, (s) => { s.asset.name = 'Renamed'; });
    chain.publish(SAT, pub1(e, undefined, res('version 1')));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'accepted' });
    const { w: w2, anchor: a2, chain: c2 } = await anchoredWorld('full');
    const none = await later(w2, a2, (s) => { s.asset.name = 'Renamed'; s.asset.body = 'none'; });
    c2.publish(SAT, pub1(none));
    expect(labelOf(await verifyOriginal(c2.evidence(w2.did)), none)).toMatchObject({ status: 'accepted' });
  });

  test('T9-101: an entry after the anchor that changes the resource and names a new preview, inscribed with it as its body, is accepted', async () => {
    const { w, anchor, chain } = await anchoredWorld('preview');
    const p2 = enc('PRV2');
    const e = await later(w, anchor, (s) => { w.version(s, res('version 2')); s.asset.preview = preview(p2); });
    chain.publish(SAT, pub1(e, undefined, p2));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(e.versionId);
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted', ordering: 'chain-ordered' });
  });

  test('T9-099: an entry after the anchor naming a preview, signed but never inscribed, is not current', async () => {
    const { w, anchor, chain } = await anchoredWorld('preview');
    const e = await later(w, anchor, (s) => { w.version(s, res('version 2')); s.asset.preview = preview(enc('NEW')); });
    const r = await verifyOriginal(chain.evidence(w.did, { extra: [{ kind: 'log', source: 'copy', bytes: enc([...w.entries, e].map((x) => JSON.stringify(x)).join('\n') + '\n') }] }));
    expect(r.checkpoint).toBe(anchor.versionId);
    expect(labelOf(r, e)).toEqual({ versionId: e.versionId, status: 'ignored' });
  });

  test('T9-025: an inscription whose entry is a delta rather than the full state is rejected; the baseline defines no compact encoding', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const e = await later(w, anchor, (s) => { s.asset.name = 'Delta'; });
    const delta = { ...e, state: { asset: { name: 'Delta' } } };
    chain.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: [delta as never] }), body: null })]);
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(anchor.versionId);
    expect(labelOf(r, delta as never)?.status).not.toBe('accepted');
  });
});

describe('signer versions on Bitcoin (P9.15, P9.33)', () => {
  test('T9-047: an entry before the anchoring entry signed by a key removed before the publication is accepted against the version it names', async () => {
    const w = await World.create();
    const k1Entry = await w.entry((s) => { s.asset.name = 'by K1'; });
    const k2 = seeded(241);
    await web(w).rotate([{ fragment: 'key-2', signer: k2 }]); // v2 removes key-1
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { ref: w.author.ref('key-2'), key: k2 });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r).bitcoin).toBe('anchored');
    expect(labelOf(r, k1Entry)).toMatchObject({ status: 'accepted', ordering: 'existed-by-block' });
    expect(labelOf(r, anchor)).toMatchObject({ status: 'accepted', ordering: 'chain-ordered' });
  });

  test('T9-002: an inscription after the anchor naming a did:webvh author version not inscribed on the sat is rejected, not unverifiable', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]); // v2, published off Bitcoin only
    const e = await later(w, anchor, (s) => { s.asset.name = 'names v2'; });
    chain.publish(SAT, pub1(e)); // no signer history carried: v2 is not on the sat
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected' });
    expect(r.bitcoin?.unverifiable).toEqual([]);
    expect(axes(r)).toMatchObject({ state: 'current', identity: 'complete' });
  });

  test('T9-109: an inscription after the anchor naming a did:webvh version number held under another versionId is rejected', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const real = w.author.ref();
    const fake = { ...real, versionId: real.versionId.replace(/-.+$/, '-QmV2yQcaZ5eeDyWKqeHW5whoWmhtH9ZygNfDcnFEqEt4vW') };
    const e = await later(w, anchor, (s) => { s.asset.name = 'x'; }, { ref: fake });
    chain.publish(SAT, pub1(e));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'rejected' });
  });

  test('T9-115: an entry in the anchoring publication naming a version number held under another versionId: rejected, so no anchor', async () => {
    const w = await World.create();
    const real = w.author.ref();
    const fake = { ...real, versionId: real.versionId.replace(/-.+$/, '-QmV2yQcaZ5eeDyWKqeHW5whoWmhtH9ZygNfDcnFEqEt4vW') };
    await w.entry((s) => { s.asset.name = 'x'; }, { ref: fake });
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
  });

  test('T9-116, T9-124: an inscription whose did:btco signer\'s sat is not read in full but that fails a check needing no such sat is rejected, not unverifiable (first matching row)', async () => {
    const chain = new Chain();
    const { editor } = btcoEditor(chain);
    const w = await World.create();
    await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, anchoring(w));
    const outside = await later(w, anchor, (s) => { s.asset.metadata = { not: 'granted' }; }, { by: editor, editor: true });
    chain.publish(SAT, pub1(outside));
    const r = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(EDITOR_SAT, 'ord-a', false)] }));
    expect(labelOf(r, outside)).toMatchObject({ status: 'rejected' });
    expect(r.bitcoin?.unverifiable).toEqual([]);
  });

  test('T9-119: a did:btco editor whose named version is known but an earlier inscription on its sat is unread: unverifiable', async () => {
    const chain = new Chain();
    const { editor } = btcoEditor(chain, { unreadBefore: true });
    const w = await World.create();
    await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, anchoring(w));
    const e = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: editor, editor: true });
    const [u] = chain.publish(SAT, pub1(e));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toEqual({ versionId: e.versionId, status: 'unverifiable' });
    expect(r.bitcoin?.unverifiable.map((x) => x.inscription)).toEqual([u]);
  });

  test('T9-113: an earlier unverifiable inscription found invalid once its sat is read in full: the later publication from the same head is accepted', async () => {
    const chain = new Chain();
    const { editor } = btcoEditor(chain);
    const w = await World.create();
    await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, anchoring(w));
    // The editor names a version that is not on its sat: rejected once the sat is read in full.
    const bad = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: editor, editor: true, ref: editor.ref('key-1', 'f'.repeat(64) + 'i0') });
    const good = await later(w, anchor, (s) => { s.asset.name = 'by author'; });
    chain.publish(SAT, pub1(bad));
    chain.publish(SAT, pub1(good));
    const partial = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(EDITOR_SAT, 'ord-a', false)] }));
    expect(labelOf(partial, good)?.status).not.toBe('accepted');
    const full = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(full, bad)).toMatchObject({ status: 'rejected' });
    expect(full.checkpoint).toBe(good.versionId);
  });
});

describe('competing anchors (P9.16)', () => {
  test('T9-076: an earlier anchoring publication naming a signer version Bitcoin does not evidence is not an anchor; a later valid one on another sat is', async () => {
    const w = await World.create();
    const base = w.head;
    const a = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: base, push: false });
    const b = await w.entry((s) => { s.asset.aliases = [SAT2]; s.asset.body = 'none'; }, { parent: base, push: false });
    const chain = new Chain();
    chain.publish(SAT, buildPublication({ entries: [base, a], body: null }), { height: 150 }); // no inscribed author history
    chain.publish(SAT2, anchoring(w, { entries: [base, b] }), { height: 160 });
    chain.height = 170;
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.bitcoin?.sat).toBe(SAT2);
    expect(r.checkpoint).toBe(b.versionId);
  });

  test('T9-077: an earlier anchoring publication with a did:btco signer whose sat is not read in full, and a later valid one: undetermined', async () => {
    const chain = new Chain();
    const { editor } = btcoEditor(chain);
    const w = await World.create();
    const g = await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
    const byEditor = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: editor, editor: true });
    const a = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const b = await w.entry((s) => { s.asset.aliases = [SAT2]; s.asset.body = 'none'; }, { parent: g, push: false });
    // Both after the editor's did:btco version, so it precedes them in chain order (P5.13).
    chain.publish(SAT, anchoring(w, { entries: [w.entries[0], g, byEditor, a] }), { height: 250 });
    chain.publish(SAT2, anchoring(w, { entries: [w.entries[0], g, b] }), { height: 260 });
    chain.height = 270;
    const r = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(SAT2), chain.read(EDITOR_SAT, 'ord-a', false)] }));
    expect(axes(r).bitcoin).toBe('undetermined');
    expect(r.bitcoin).toBeUndefined();
    const decided = await verifyOriginal(chain.evidence(w.did));
    expect(decided.bitcoin?.sat).toBe(SAT);
  });

  test('T9-106: after anchoring, an editor entry and the revoking author entry with the same parent: the first in chain order is accepted, the other ignored', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [{ did: ed.did, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const byEditor = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    const revoke = await later(w, anchor, (s) => { delete s.asset.editors; });
    chain.publish(SAT, pub1(byEditor, [history(ed)]));
    chain.publish(SAT, pub1(revoke));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(byEditor.versionId);
    expect(labelOf(r, revoke)).toEqual({ versionId: revoke.versionId, status: 'ignored' });
  });
});

describe('inscribed signer histories (P9.33, P14.13)', () => {
  test('T14-027: an inscribed signer history that continues after a deactivated version rejects its publication', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    await web(w).appendState(web(w).entries[web(w).entries.length - 1].state, { deactivated: true });
    const e1 = await later(w, anchor, (s) => { s.asset.metadata = { n: 1 }; });
    chain.publish(SAT, pub1(e1, [history(w.author, 2, 2)])); // the deactivation, inscribed: e1 is rejected (row 8)
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]); // a version after the deactivation
    const e2 = await later(w, anchor, (s) => { s.asset.metadata = { n: 2 }; });
    chain.publish(SAT, pub1(e2, [history(w.author, 2, 3)]));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(anchor.versionId);
    expect(labelOf(r, e2)?.status).toBe('rejected');
  });
});

describe('one tip (P9.31)', () => {
  test('T9-065: a sat read at another tip than the evidence set\'s is unusable: a holder or inscriptions read at different tips are never combined', async () => {
    const r = await verifyOriginal(withSatRead(bitcoinEvidence(), (s) => { s.tip.height += 1; for (const x of s.inscriptions) x.confirmations += 1; }));
    expect(r.diagnostics.map((d) => d.code)).toContain('input-unusable');
    expect(axes(r).bitcoin).not.toBe('anchored');
  });
});
