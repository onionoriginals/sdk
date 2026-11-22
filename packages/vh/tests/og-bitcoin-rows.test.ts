// did:og on Bitcoin: matrix rows of §9 and the Bitcoin rows of §5, §7 and §14.
import { describe, expect, test } from 'bun:test';
import { encodeCbor } from '../src/originals/cbor.js';
import {
  buildPublication, defaultCheck, encodeEnvelope, encodeMetadata, readInscription, resourceDigest, serializeLog, transferCheck, verifyOriginal,
  type OgEntry,
} from '../src/og/index.js';
import { anchoring, Chain, history, rawEnvelope } from './helpers/og-chain.js';
import { seeded, WebvhAuthor } from './helpers/originals.js';
import { axes, enc, labelOf, res, webvhSigner, World } from './helpers/og-world.js';

const SAT = 'did:btco:reg:5000';
const SAT2 = 'did:btco:reg:6000';
const web = (w: World) => w.author.handle as WebvhAuthor;

async function anchoredWorld(body: 'none' | 'full' | 'preview' = 'none', sat = SAT) {
  const w = await World.create();
  const before = await w.entry((s) => { s.asset.name = 'Two'; });
  const anchor = await w.entry((s) => {
    s.asset.aliases = [sat];
    s.asset.body = body;
    if (body === 'preview') s.asset.preview = { mediaType: 'image/webp', size: 3, digest: resourceDigest(enc('PRV')) };
  });
  const chain = new Chain();
  const bodyBytes = body === 'full' ? res('version 1') : body === 'preview' ? enc('PRV') : null;
  const ids = chain.publish(sat, anchoring(w, { body: bodyBytes }));
  return { w, before, anchor, chain, ids };
}

const later = (w: World, parent: OgEntry, change: (s: any) => void, opts: Parameters<World['entry']>[1] = {}) => w.entry((s) => { change(s); }, { parent, push: false, ...opts });
const pub1 = (e: OgEntry, signers?: ReturnType<typeof history>[], body: Uint8Array | null = null) => buildPublication({ entries: [e], signers, body });

describe('anchoring (P9.10, P9.16, P9.18)', () => {
  test('T9-011, T9-024, T9-030, T9-075, T9-120: anchored from the local layer; earlier entries existed-by-block; holder provisional; no author host needed', async () => {
    const { w, before, anchor, chain } = await anchoredWorld();
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ outcome: 'verified', state: 'current', bitcoin: 'anchored', identity: 'complete', offline: 'needs-external' });
    expect(labelOf(r, before)).toMatchObject({ ordering: 'existed-by-block', block: 201 });
    expect(labelOf(r, anchor)).toMatchObject({ ordering: 'chain-ordered', block: 201 });
    expect(r.bitcoin?.holder.uniqueness).toBe('provisional');
    expect(r.evidence).toMatchObject({ network: 'regtest', tip: { height: 211 }, depth: 1 });
    expect(r.signers?.[0]).toMatchObject({ freshness: 'established', source: expect.stringMatching(/^inscribed:/) });
    expect(defaultCheck(r)).toBe(true);
    expect(transferCheck(r)).toBe(true);
  });

  test('T9-074: an Originals index trusted through block N establishes uniqueness through N only', async () => {
    const { w, chain } = await anchoredWorld();
    const r = await verifyOriginal(chain.evidence(w.did, { originalsIndex: { name: 'og-index', through: 205 } }));
    expect(r.bitcoin?.holder.uniqueness).toEqual({ 'established-through': 205 });
  });

  test('T9-004: the new holder of the sat is the holder; the author is unchanged', async () => {
    const { w, chain } = await anchoredWorld();
    chain.holders.set(SAT, 'bcrt1pnewholder');
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.bitcoin?.holder.address).toBe('bcrt1pnewholder');
    expect(r.signers?.[0].did).toBe(w.author.did);
  });

  test('T9-014, T9-010, T9-044: an anchoring entry inscribed on a sat other than the one it names is not an anchor', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT2, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r).bitcoin).toBe('not-anchored');
    expect(r.bitcoin).toBeUndefined();
  });

  test('T9-121: a signed anchoring entry not inscribed on the sat it names is not anchored', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.inscribe(SAT, [rawEnvelope([[1, enc('text/plain')]], enc('hello'))]);
    const r = await verifyOriginal(chain.evidence(w.did, { extra: [{ kind: 'log', source: 'copy', bytes: enc(serializeLog(w.entries)) }] }));
    expect(axes(r).bitcoin).toBe('not-anchored');
    expect(axes(r).state).not.toBe('current');
  });

  test('T9-013: two valid anchors on different sats: the first in chain order is the anchor; the other conflicts', async () => {
    const w = await World.create();
    const base = w.head;
    const a = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: base, push: false });
    const b = await w.entry((s) => { s.asset.aliases = [SAT2]; s.asset.body = 'none'; }, { parent: base, push: false });
    const chain = new Chain();
    chain.publish(SAT2, anchoring(w, { entries: [base, b] }));
    chain.publish(SAT, anchoring(w, { entries: [base, a] }));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.bitcoin?.sat).toBe(SAT2);
    expect(r.bitcoin?.conflictingAnchors).toEqual([{ sat: SAT, inscription: chain.sats.get(SAT)![0].id }]);
    expect(r.checkpoint).toBe(b.versionId);
    expect(transferCheck(r)).toBe(false);
  });

  test('T9-042, T9-043: a publication not starting at genesis, or whose last entry is not an anchoring entry, is not an anchor', async () => {
    const { w, chain: _c } = await anchoredWorld();
    const chain = new Chain();
    chain.publish(SAT, anchoring(w, { entries: w.entries.slice(1) }));
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
    const chain2 = new Chain();
    const w2 = await World.create();
    await w2.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const extra = await w2.entry((s) => { s.asset.name = 'after'; });
    void extra;
    chain2.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: w2.entries, signers: [history(w2.author)] }), body: null })]);
    expect(axes(await verifyOriginal(chain2.evidence(w2.did))).bitcoin).toBe('not-anchored');
  });

  test('T9-056, T9-057: a sat taken by a valid anchoring publication for another did:og; an invalid one takes no sat', async () => {
    const other = await World.create();
    await other.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const { w, chain: _c } = await anchoredWorld();
    const chain = new Chain();
    chain.publish(SAT, anchoring(other));
    chain.publish(SAT, anchoring(w));
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
    const chain2 = new Chain();
    chain2.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: other.entries }), body: null })]); // no signer history: invalid
    chain2.publish(SAT, anchoring(w));
    expect(axes(await verifyOriginal(chain2.evidence(w.did))).bitcoin).toBe('anchored');
  });

  test('T9-032: an anchoring sat not read in full is missing evidence; outcome incomplete', async () => {
    const { w, chain } = await anchoredWorld();
    const r = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT, 'ord-a', false)], extra: [{ kind: 'log', source: 'copy', bytes: enc(serializeLog(w.entries)) }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'missing-evidence', outcome: 'incomplete' });
  });

  test('T9-049, T9-064: two indexes that disagree on the sat\'s inscriptions are missing evidence', async () => {
    const { w, chain } = await anchoredWorld();
    const a = chain.read(SAT, 'ord-a');
    const b = { ...chain.read(SAT, 'ord-b'), inscriptions: [] };
    expect(axes(await verifyOriginal(chain.evidence(w.did, { reads: [a, b] }))).bitcoin).toBe('missing-evidence');
    expect(axes(await verifyOriginal(chain.evidence(w.did, { reads: [a, chain.read(SAT, 'ord-b')] }))).bitcoin).toBe('anchored');
  });

  test('T9-045, T9-055: reads from another network than the genesis network are not evidence', async () => {
    const { w, chain } = await anchoredWorld();
    const r = await verifyOriginal(chain.evidence(w.did, { network: 'signet' }));
    expect(axes(r).bitcoin).not.toBe('anchored');
  });

  test('T9-033: an unconfirmed inscription is observed, not in the accepted log', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w), { confirmations: 0 });
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
  });

  test('T9-038 (verifier side), T9-019: an anchoring publication whose author version is not inscribed is not an anchor', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
  });
});

describe('after the anchor (P9.12, P9.13, P9.15, P9.36)', () => {
  test('T9-007, T9-080: an author-signed entry inscribed by the holder, however long after signing, is accepted', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    chain.height += 1000;
    chain.publish(SAT, pub1(e));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(e.versionId);
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted', ordering: 'chain-ordered' });
  });

  test('T9-005, T9-031: an author-signed entry not inscribed, and a differing copy, are ignored', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    const r = await verifyOriginal(chain.evidence(w.did, { extra: [{ kind: 'log', source: 'copy', bytes: enc(serializeLog([...w.entries, e])) }] }));
    expect(labelOf(r, e)).toEqual({ versionId: e.versionId, status: 'ignored' });
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-006: an inscription signed by neither the author nor a granted editor is rejected; state unchanged', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const holder = await webvhSigner();
    const e = await later(w, anchor, (s) => { s.asset.name = 'Holder'; }, { key: holder.key });
    chain.publish(SAT, pub1(e));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected' });
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-009: a newer inscription that does not extend the head is ignored', async () => {
    const { w, before, chain } = await anchoredWorld();
    const fork = await later(w, before, (s) => { s.asset.name = 'Fork'; });
    chain.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: [fork] }), body: null })]);
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, fork)).toEqual({ versionId: fork.versionId, status: 'ignored' });
  });

  test('T9-029: a later publication carrying more than one entry is rejected', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const e3 = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    const e4 = await later(w, e3, (s) => { s.asset.name = 'Four'; });
    chain.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: [e3, e4] }), body: null })]);
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-078 / T9-079: a publication and the one extending it in one block, in order / in reverse order', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const e3 = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    const e4 = await later(w, e3, (s) => { s.asset.name = 'Four'; });
    const inOrder = new Chain();
    inOrder.sats.set(SAT, [...chain.sats.get(SAT)!]);
    inOrder.height = chain.height + 1;
    inOrder.inscribe(SAT, [pub1(e3)[0].envelope, pub1(e4)[0].envelope], { height: inOrder.height });
    expect((await verifyOriginal(inOrder.evidence(w.did))).checkpoint).toBe(e4.versionId);
    const reverse = new Chain();
    reverse.sats.set(SAT, [...chain.sats.get(SAT)!]);
    reverse.height = chain.height + 1;
    reverse.inscribe(SAT, [pub1(e4)[0].envelope, pub1(e3)[0].envelope], { height: reverse.height });
    const r = await verifyOriginal(reverse.evidence(w.did));
    expect(r.checkpoint).toBe(e3.versionId);
    expect(labelOf(r, e4)).toEqual({ versionId: e4.versionId, status: 'ignored' });
  });

  test('T9-017, T7-006, T9-072: a key removed off Bitcoin after anchoring does not affect inscribed entries', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    await web(w).rotate([{ fragment: 'key-2', signer: seeded(220) }]);
    const r = await verifyOriginal(chain.evidence(w.did, { extra: [{ kind: 'signer-history', source: 'newer', bytes: enc(w.author.log()), did: w.author.did }] }));
    expect(labelOf(r, anchor)).toMatchObject({ status: 'accepted', authority: 'current-key' });
    expect(axes(r).state).toBe('current');
  });

  test('T9-036, T7-005 (anchored): a later inscribed version that removes the key refuses the next entry', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    await web(w).rotate([{ fragment: 'key-2', signer: seeded(221) }]);
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; }, { ref: { ...w.author.ref('key-1', w.entries[0].state.author.versionId) } as never });
    chain.publish(SAT, pub1(e, [history(w.author, 2)]));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected', rule: 'P9.15' });
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-069, T9-070, T9-071: a version inscribed earlier in the same publication counts; a gap or repeat rejects it; history in a rejected publication is ignored', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const k2 = seeded(222);
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'key-2', signer: k2 }]);
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; }, { ref: w.author.ref('key-2'), key: k2 });
    const repeat = new Chain();
    repeat.sats.set(SAT, [...chain.sats.get(SAT)!]);
    repeat.publish(SAT, pub1(e, [history(w.author, 1)]));
    expect((await verifyOriginal(repeat.evidence(w.did))).checkpoint).toBe(anchor.versionId);
    chain.publish(SAT, pub1(e, [history(w.author, 2)]));
    expect((await verifyOriginal(chain.evidence(w.did))).checkpoint).toBe(e.versionId);
  });

  test('T7-007, T9-018 (anchored): after the author DID deactivates on the sat, later entries are rejected; the accepted state stays current', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    await web(w).appendState(web(w).entries[web(w).entries.length - 1].state, { deactivated: true });
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    chain.publish(SAT, pub1(e, [history(w.author, 2)]));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected' });
    expect(axes(r).state).toBe('current');
  });

  test('T9-107: an editor entry inscribed by the holder is accepted', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [{ did: ed.did, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const e = await later(w, anchor, (s) => { s.asset.name = 'Edited'; }, { by: ed, editor: true });
    chain.publish(SAT, pub1(e, [history(ed)]));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted' });
    expect(r.signers?.map((s) => s.role)).toEqual(['author', 'editor']);
  });
});

describe('bodies (P9.17, P9.30)', () => {
  test('T9-035, T9-087: a full-body inscription carries the current version, checked against its descriptor', async () => {
    const { w, chain } = await anchoredWorld('full');
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ availability: 'complete', bitcoin: 'anchored' });
  });

  test('T9-086, T9-088, T7-012: preview or none: the log verifies; versions not inscribed in full are missing', async () => {
    for (const body of ['preview', 'none'] as const) {
      const { w, chain } = await anchoredWorld(body);
      const r = await verifyOriginal(chain.evidence(w.did));
      expect(axes(r)).toMatchObject({ outcome: 'verified', availability: 'none' });
      expect(r.missing).toHaveLength(1);
    }
  });

  test('T9-068, T9-081, T9-082, T9-097: a body that does not match the signed mode is rejected and is no anchor', async () => {
    const cases: Array<['none' | 'full' | 'preview', Uint8Array | null, string | null]> = [
      ['none', enc('x'), 'text/plain'], ['full', null, null], ['full', res('version X'), 'text/plain'], ['full', res('version 1'), 'text/html'], ['preview', res('version 1'), 'text/plain'],
    ];
    for (const [mode, body, ct] of cases) {
      const w = await World.create();
      await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = mode; if (mode === 'preview') s.asset.preview = { mediaType: 'image/webp', size: 3, digest: resourceDigest(enc('PRV')) }; });
      const chain = new Chain();
      chain.inscribe(SAT, [encodeEnvelope({ contentType: ct, metadata: encodeMetadata({ entries: w.entries, signers: [history(w.author)] }), body })]);
      expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('not-anchored');
    }
  });

  test('T9-104: an empty body is a body: the full version of a 0-byte resource', async () => {
    const w = await World.create(undefined, {}, new Uint8Array());
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'full'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w, { body: new Uint8Array() }));
    expect(readInscription(chain.sats.get(SAT)![0].envelope)).toMatchObject({ kind: 'originals', body: new Uint8Array() });
    expect(axes(await verifyOriginal(chain.evidence(w.did)))).toMatchObject({ bitcoin: 'anchored', availability: 'complete' });
  });
});

describe('publications in parts (P9.32)', () => {
  async function big() {
    const w = await World.create();
    const pad = 'x'.repeat(60_000);
    for (let i = 0; i < 7; i++) await w.entry((s) => { s.asset.metadata = { pad: pad + i }; });
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; delete s.asset.metadata; });
    return w;
  }

  test('T9-052 (writer), T9-058: a log too large for one inscription is published in parts; an unrelated inscription does not interrupt', async () => {
    const w = await big();
    const parts = anchoring(w);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const chain = new Chain();
    chain.publish(SAT, [parts[0]]);
    chain.inscribe(SAT, [rawEnvelope([[1, enc('text/plain')]], enc('unrelated'))]);
    chain.publish(SAT, parts.slice(1));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r).bitcoin).toBe('anchored');
    expect(labelOf(r, w.head)).toMatchObject({ block: chain.sats.get(SAT)!.at(-1)!.height });
  });

  test('T9-059, T9-060, T9-061: parts interrupted by an Originals inscription are rejected; no final part changes nothing; a body before the final part rejects it', async () => {
    const w = await big();
    const parts = anchoring(w);
    const interrupted = new Chain();
    interrupted.publish(SAT, [parts[0]]);
    interrupted.inscribe(SAT, [encodeEnvelope({ metadata: encodeMetadata({ entries: [] }), body: null })]);
    interrupted.publish(SAT, parts.slice(1));
    expect(axes(await verifyOriginal(interrupted.evidence(w.did))).bitcoin).toBe('not-anchored');
    const unfinished = new Chain();
    unfinished.publish(SAT, [parts[0]]);
    expect(axes(await verifyOriginal(unfinished.evidence(w.did))).bitcoin).toBe('not-anchored');
    const bodied = new Chain();
    const m0 = readInscription(parts[0].envelope);
    if (m0.kind !== 'originals') throw new Error('part');
    bodied.inscribe(SAT, [encodeEnvelope({ contentType: 'text/plain', metadata: parts[0].metadata, body: enc('early') })]);
    bodied.publish(SAT, parts.slice(1));
    expect(axes(await verifyOriginal(bodied.evidence(w.did))).bitcoin).toBe('not-anchored');
  });

  test('T9-062: the writer refuses a publication over 16 parts; a reader rejects part numbers over 16', () => {
    expect(() => readInscription(encodeEnvelope({ metadata: encodeCbor({ entries: [], part: [1, 17] }), body: null }))).not.toThrow();
    expect(readInscription(encodeEnvelope({ metadata: encodeCbor({ entries: [], part: [1, 17] }), body: null }))).toMatchObject({ kind: 'invalid', rule: 'P9.32' });
    expect(readInscription(encodeEnvelope({ metadata: encodeCbor({ entries: [], part: [1, 16] }), body: null }))).toMatchObject({ kind: 'originals' });
  });

  test('T14-092, T14-010: metadata over 520 bytes in several pushes is concatenated and read like any other', async () => {
    const { chain } = await anchoredWorld();
    const env = chain.sats.get(SAT)![0].envelope;
    const r = readInscription(env);
    expect(r.kind).toBe('originals');
    if (r.kind === 'originals') expect(r.metadataBytes).toBeGreaterThan(520);
  });
});

describe('inscription fields and metadata (P14.12, P9.31)', () => {
  const meta = encodeCbor({ entries: [] });
  test('T9-063, T9-105: a pointer, parent, content encoding, delegate or unknown field rejects the inscription', () => {
    for (const tag of [2, 3, 9, 11, 13]) {
      expect(readInscription(rawEnvelope([[7, enc('og')], [5, meta], [tag, Uint8Array.of(1)]]))).toMatchObject({ kind: 'invalid' });
    }
  });

  test('T9-028, T3-008: an inscription without the og metaprotocol, such as a did:btco document, is not an Originals inscription', () => {
    expect(readInscription(rawEnvelope([[5, encodeCbor({ id: SAT })]]))).toMatchObject({ kind: 'other' });
  });

  test('T14-003, T14-007, T14-009: an array of entries, an extra member, a tag, a byte string, an indefinite length, NaN or -0 is rejected', () => {
    const bad = [
      encodeCbor([]), encodeCbor({ entries: [], extra: 1 }),
      Uint8Array.of(0xa1, 0x67, ...enc('entries'), 0xc0, 0x80), Uint8Array.of(0xa1, 0x67, ...enc('entries'), 0x40),
      Uint8Array.of(0xa1, 0x67, ...enc('entries'), 0x9f, 0xff), Uint8Array.of(0xa1, 0x67, ...enc('entries'), 0x81, 0xa1, 0x61, 0x61, 0xf9, 0x7e, 0x00),
      Uint8Array.of(0xa1, 0x67, ...enc('entries'), 0x81, 0xa1, 0x61, 0x61, 0xf9, 0x80, 0x00),
      Uint8Array.of(0xa2, 0x67, ...enc('entries'), 0x80, 0x67, ...enc('entries'), 0x80),
    ];
    for (const m of bad) expect(readInscription(rawEnvelope([[7, enc('og')], [5, m]]))).toMatchObject({ kind: 'invalid' });
  });

  test('T14-008, T14-011: a float in an entry\'s metadata, in any width, is checked over the entry\'s JCS form', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.metadata = { ratio: 1.5 }; });
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    expect(axes(await verifyOriginal(chain.evidence(w.did))).bitcoin).toBe('anchored');
  });

  test('T14-002: two content types do not decode deterministically', () => {
    expect(readInscription(rawEnvelope([[1, enc('a/b')], [1, enc('c/d')], [7, enc('og')], [5, meta]], enc('x')))).toMatchObject({ kind: 'invalid' });
  });

  test('T9-051, T9-052: metadata and body of exactly 350,000 bytes are accepted; one byte more is rejected', async () => {
    const author = await webvhSigner('limit.example.com');
    const at = async (target: number) => {
      // Find the resource size that makes metadata + body hit `target` (the digest length is fixed).
      let size = 340_000;
      for (let i = 0; i < 8; i++) {
        const w = await World.create(author, {}, new Uint8Array(size).fill(65));
        await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'full'; });
        const metadata = encodeMetadata({ entries: w.entries, signers: [history(w.author)] });
        if (metadata.length + size === target) {
          const chain = new Chain();
          chain.inscribe(SAT, [encodeEnvelope({ contentType: 'text/plain', metadata, body: new Uint8Array(size).fill(65) })]);
          return axes(await verifyOriginal(chain.evidence(w.did))).bitcoin;
        }
        size += target - (metadata.length + size);
      }
      throw new Error('size did not converge');
    };
    expect(await at(350_000)).toBe('anchored');
    expect(await at(350_001)).toBe('not-anchored');
  });
});

describe('did:btco signers (P5.13, P9.15 rows 4–5)', () => {
  const AUTHOR_SAT = 'did:btco:reg:777';
  async function btcoWorld() {
    const chain = new Chain();
    const k1 = seeded(230);
    const doc = (keys: Array<[string, typeof k1]>) => ({
      '@context': ['https://www.w3.org/ns/did/v1'], id: AUTHOR_SAT,
      verificationMethod: keys.map(([f, k]) => ({ id: `${AUTHOR_SAT}#${f}`, type: 'Multikey', controller: AUTHOR_SAT, publicKeyMultibase: k.publicKeyMultibase })),
      assertionMethod: keys.map(([f]) => `${AUTHOR_SAT}#${f}`),
    });
    const v1 = chain.btcoVersion(AUTHOR_SAT, doc([['key-1', k1]]));
    const author = { did: AUTHOR_SAT, key: k1, kind: 'webvh' as const, handle: null as never, log: () => '', ref: (f = 'key-1', v = v1) => ({ did: AUTHOR_SAT, verificationMethod: `${AUTHOR_SAT}#${f}`, versionId: v }) };
    const w = await World.create(author);
    return { chain, w, k1, v1, doc };
  }

  test('T5-014: an anchored Original with a did:btco author is checked against its sat\'s versions in chain order', async () => {
    const { chain, w } = await btcoWorld();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ bitcoin: 'anchored', identity: 'complete' });
    expect(r.dependencies).toContainEqual({ kind: 'signer-sat', did: AUTHOR_SAT });
  });

  test('T5-021, T5-022, T5-024: an entry naming a version inscribed after its own inscription is rejected', async () => {
    const { chain, w, k1, doc } = await btcoWorld();
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const v2 = chain.btcoVersion(AUTHOR_SAT, doc([['key-1', k1]]));
    const e = await later(w, anchor, (s) => { s.asset.name = 'Later'; }, { ref: w.author.ref('key-1', v2) });
    // Inscribed in the same block, before the version.
    const pos = chain.sats.get(AUTHOR_SAT)!.at(-1)!;
    chain.inscribe(SAT, [pub1(e)[0].envelope], { height: pos.height, txIndex: 0 });
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected', rule: 'P5.13' });
  });

  test('T5-023: naming a version inscribed earlier in the same block is accepted', async () => {
    const { chain, w, k1, doc } = await btcoWorld();
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const v2 = chain.btcoVersion(AUTHOR_SAT, doc([['key-1', k1]]));
    const e = await later(w, anchor, (s) => { s.asset.name = 'Later'; }, { ref: w.author.ref('key-1', v2) });
    const pos = chain.sats.get(AUTHOR_SAT)!.at(-1)!;
    chain.inscribe(SAT, [pub1(e)[0].envelope], { height: pos.height, txIndex: pos.txIndex + 1 });
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'accepted' });
  });

  test('T5-025, T5-028, T5-029: the key must hold in the latest preceding version for the anchoring entry; not for entries before it', async () => {
    const { chain, w, doc } = await btcoWorld();
    const k2 = seeded(231);
    const before = await w.entry((s) => { s.asset.name = 'K1'; });
    const v2 = chain.btcoVersion(AUTHOR_SAT, doc([['key-2', k2]]));
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { ref: w.author.ref('key-2', v2), key: k2 });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, before)).toMatchObject({ status: 'accepted', ordering: 'existed-by-block' });
    expect(axes(r).bitcoin).toBe('anchored');
    // T5-029: the anchoring entry signed with K1 at v1, after v2 removed K1.
    const { chain: c2, w: w2, doc: d2 } = await btcoWorld();
    c2.btcoVersion(AUTHOR_SAT, d2([['key-2', k2]]));
    await w2.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    c2.publish(SAT, buildPublication({ entries: w2.entries, body: null }));
    expect(axes(await verifyOriginal(c2.evidence(w2.did))).bitcoin).toBe('not-anchored');
  });

  test('T5-016: an inscription on the DID\'s sat after its deactivation is not a version', async () => {
    const { chain, w, k1, doc } = await btcoWorld();
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    chain.btcoVersion(AUTHOR_SAT, { ...doc([['key-1', k1]]), deactivated: true });
    const v3 = chain.btcoVersion(AUTHOR_SAT, doc([['key-1', k1]]));
    const e = await later(w, anchor, (s) => { s.asset.name = 'x'; }, { ref: w.author.ref('key-1', v3) });
    chain.publish(SAT, pub1(e));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'rejected' });
  });

  test('T9-108, T9-112, T9-117, T9-122, T7-055, T9-118, T9-123: an inscription whose did:btco signer\'s sat is not read in full is unverifiable; later ones wait; state stays current', async () => {
    const chain = new Chain();
    const EDITOR_SAT = 'did:btco:reg:888';
    const ke = seeded(232);
    const v1 = chain.btcoVersion(EDITOR_SAT, { id: EDITOR_SAT, verificationMethod: [{ id: `${EDITOR_SAT}#key-1`, type: 'Multikey', controller: EDITOR_SAT, publicKeyMultibase: ke.publicKeyMultibase }], assertionMethod: [`${EDITOR_SAT}#key-1`] });
    const editor = { did: EDITOR_SAT, key: ke, kind: 'webvh' as const, handle: null as never, log: () => '', ref: (f = 'key-1', v = v1) => ({ did: EDITOR_SAT, verificationMethod: `${EDITOR_SAT}#${f}`, versionId: v }) };
    const w = await World.create();
    await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, anchoring(w));
    const byEditor = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: editor, editor: true });
    const byAuthor = await later(w, anchor, (s) => { s.asset.name = 'by author'; });
    const [u] = chain.publish(SAT, pub1(byEditor));
    const [wt] = chain.publish(SAT, pub1(byAuthor));
    const partial = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(EDITOR_SAT, 'ord-a', false)] }));
    expect(axes(partial)).toMatchObject({ state: 'current', identity: 'complete', bitcoin: 'anchored' });
    expect(partial.checkpoint).toBe(anchor.versionId);
    expect(partial.bitcoin?.unverifiable).toEqual([{ inscription: u, did: EDITOR_SAT, versionId: v1 }]);
    expect(partial.bitcoin?.waiting).toEqual([{ inscription: wt, waitsOn: u }]);
    expect(defaultCheck(partial)).toBe(true);
    expect(transferCheck(partial)).toBe(false);
    // A larger evidence set reads the editor's sat in full: the editor entry is accepted, the author's from the same head ignored.
    const full = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(EDITOR_SAT)], prior: partial }));
    expect(full.checkpoint).toBe(byEditor.versionId);
    expect(labelOf(full, byAuthor)).toEqual({ versionId: byAuthor.versionId, status: 'ignored' });
    expect(full.headChange).toEqual({ from: anchor.versionId, to: byEditor.versionId });
  });

  async function editorUnderBtcoAuthor() {
    const { chain, w, k1, doc } = await btcoWorld();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [{ did: ed.did, name: true, metadata: false, resource: false }]; });
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const e = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    return { chain, w, ed, anchor, e, k1, doc };
  }

  test('T9-130: a post-anchor did:webvh editor entry whose did:btco author\'s sat is not read in full at its inscription is unverifiable; later publications wait; the state stays current (row 6)', async () => {
    const { chain, w, ed, anchor, e } = await editorUnderBtcoAuthor();
    chain.unread(AUTHOR_SAT); // the author's history ends before this inscription (P5.13)
    const [u] = chain.publish(SAT, pub1(e, [history(ed)]));
    const n = await later(w, e, (s) => { s.asset.name = 'after'; });
    const [wt] = chain.publish(SAT, pub1(n));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toEqual({ versionId: e.versionId, status: 'unverifiable' });
    expect(r.bitcoin?.unverifiable).toEqual([{ inscription: u, did: AUTHOR_SAT, versionId: (e.state.author as { versionId: string }).versionId }]);
    expect(r.bitcoin?.waiting).toEqual([{ inscription: wt, waitsOn: u }]);
    expect(axes(r)).toMatchObject({ state: 'current', bitcoin: 'anchored' });
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-130 (anchoring publication): with the did:btco author\'s sat not read in full, identity is incomplete and the anchor is undetermined', async () => {
    const { chain, w } = await btcoWorld();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const r = await verifyOriginal(chain.evidence(w.did, { reads: [chain.read(SAT), chain.read(AUTHOR_SAT, 'ord-a', false)] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'undetermined', outcome: 'incomplete' });
  });

  test('T9-131: the same editor entry with the author\'s sat read in full and no deactivation is accepted, chain-ordered', async () => {
    const { chain, w, ed, e } = await editorUnderBtcoAuthor();
    chain.publish(SAT, pub1(e, [history(ed)]));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'accepted', ordering: 'chain-ordered' });
  });

  test('T9-132: the did:btco author deactivated on its sat before the editor entry\'s inscription: rejected', async () => {
    const { chain, w, ed, anchor, e, k1, doc } = await editorUnderBtcoAuthor();
    chain.btcoVersion(AUTHOR_SAT, { ...doc([['key-1', k1]]), deactivated: true });
    chain.publish(SAT, pub1(e, [history(ed)]));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected', rule: 'P5.18' });
    expect(r.checkpoint).toBe(anchor.versionId);
  });

  test('T9-133: a did:btco editor under a did:webvh author: (a) editor sat unread, unverifiable; (b) author deactivated in the inscribed history first, rejected; (c) accepted', async () => {
    const make = async () => {
      const chain = new Chain();
      const EDITOR_SAT = 'did:btco:reg:889';
      const ke = seeded(233);
      const v1 = chain.btcoVersion(EDITOR_SAT, { id: EDITOR_SAT, verificationMethod: [{ id: `${EDITOR_SAT}#key-1`, type: 'Multikey', controller: EDITOR_SAT, publicKeyMultibase: ke.publicKeyMultibase }], assertionMethod: [`${EDITOR_SAT}#key-1`] });
      const editor = { did: EDITOR_SAT, key: ke, kind: 'webvh' as const, handle: null as never, log: () => '', ref: (f = 'key-1', v = v1) => ({ did: EDITOR_SAT, verificationMethod: `${EDITOR_SAT}#${f}`, versionId: v }) };
      const w = await World.create();
      await w.entry((s) => { s.asset.editors = [{ did: EDITOR_SAT, name: true, metadata: false, resource: false }]; });
      const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
      chain.publish(SAT, anchoring(w));
      const e = await later(w, anchor, (s) => { s.asset.name = 'by editor'; }, { by: editor, editor: true });
      return { chain, w, e, EDITOR_SAT };
    };
    const a = await make();
    const [u] = a.chain.publish(SAT, pub1(a.e));
    const ra = await verifyOriginal(a.chain.evidence(a.w.did, { reads: [a.chain.read(SAT), a.chain.read(a.EDITOR_SAT, 'ord-a', false)] }));
    expect(ra.bitcoin?.unverifiable).toEqual([{ inscription: u, did: a.EDITOR_SAT, versionId: (a.e.state.editor as { versionId: string }).versionId }]);
    expect(labelOf(ra, a.e)).toEqual({ versionId: a.e.versionId, status: 'unverifiable' });
    const b = await make();
    await web(b.w).appendState(web(b.w).entries[web(b.w).entries.length - 1].state, { deactivated: true });
    b.chain.publish(SAT, pub1(b.e, [history(b.w.author, 2)]));
    expect(labelOf(await verifyOriginal(b.chain.evidence(b.w.did)), b.e)).toMatchObject({ status: 'rejected', rule: 'P5.18' });
    const c = await make();
    c.chain.publish(SAT, pub1(c.e));
    expect(labelOf(await verifyOriginal(c.chain.evidence(c.w.did)), c.e)).toMatchObject({ status: 'accepted', ordering: 'chain-ordered' });
  });

  test('T5-026: a did:btco document the index places on another sat is not a version', async () => {
    const { chain, w, k1, doc } = await btcoWorld();
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    chain.publish(SAT, buildPublication({ entries: w.entries, body: null }));
    const v = chain.btcoVersion('did:btco:reg:778', doc([['key-1', k1]]));
    const e = await later(w, anchor, (s) => { s.asset.name = 'x'; }, { ref: w.author.ref('key-1', v) });
    chain.publish(SAT, pub1(e));
    expect(labelOf(await verifyOriginal(chain.evidence(w.did)), e)).toMatchObject({ status: 'rejected', rule: 'P5.13' });
  });
});

describe('prior results (P9.36, P9.16)', () => {
  test('T9-037, T9-110: a head that changes against the prior result is stated', async () => {
    const { w, anchor, chain } = await anchoredWorld();
    const prior = await verifyOriginal(chain.evidence(w.did));
    const e = await later(w, anchor, (s) => { s.asset.name = 'Three'; });
    chain.publish(SAT, pub1(e));
    const r = await verifyOriginal(chain.evidence(w.did, { prior }));
    expect(r.headChange).toEqual({ from: anchor.versionId, to: e.versionId });
  });
});
