// Owner decisions of 22 November 2026 on PR #1087 (D22 review): the union rule for supplied signer
// logs (B), other sats never blocking the anchor (A), no false anchoring-sat-not-read (C), and the
// outcome of a rejected anchoring publication (E).
import { describe, expect, test } from 'bun:test';
import { serializeLog, verifyOriginal, type OgEntry, type Report } from '../src/og/index.js';
import { anchoring, Chain, history, publication } from './helpers/og-chain.js';
import { seeded, WebvhAuthor } from './helpers/originals.js';
import { axes, enc, labelOf, vhSigner, World } from './helpers/og-world.js';

const SAT = 'did:btco:reg:5000';
const SAT2 = 'did:btco:reg:6000';
const web = (w: World) => w.author.handle as WebvhAuthor;
const lines = (log: string) => log.split('\n').filter((l) => l.length);
/** The log with its line `k` (1-based) altered so that it no longer verifies from there. */
const corruptAt = (log: string, k: number) => lines(log).map((l, i) => (i === k - 1 ? l.replace('"versionTime":"2026', '"versionTime":"2027') : l)).join('\n') + '\n';
/** The report with its evidence inputs in a fixed order, to compare reports over the same inputs in other orders. */
const normal = (r: Report) => ({ ...r, evidence: { ...r.evidence, inputs: [...r.evidence.inputs].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)) } });

/** A reference to a version the author's current branch may not hold (a fork). */
const refAt = (w: World, fragment: string, versionId: string) => ({ did: w.author.did, verificationMethod: `${w.author.did}#${fragment}`, versionId });

/** An author whose log forks after v1: branch A and branch B each hold a different v2. */
async function forkedAuthor(w: World) {
  const a = web(w);
  const base = a.entries.slice();
  const kA = seeded(301);
  await a.rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'key-a', signer: kA }]);
  const logA = w.author.log();
  const v2a = a.versionId;
  a.entries = base.slice();
  await a.rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'key-b', signer: seeded(302) }]);
  const logB = w.author.log();
  const v2b = a.versionId;
  return { logA, logB, v2a, v2b, kA };
}

describe('owner decision B: the union of verifying signer logs', () => {
  test('a log corrupted at v2 is no evidence at all: the true anchor naming v3 is undetermined, and a later rogue anchor on the same sat is not reported anchored', async () => {
    const w = await World.create();
    const genesis = w.head;
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]); // v2
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]); // v3
    const good = w.author.log();
    const trueAnchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }); // names v3
    const v1 = lines(good)[0] && JSON.parse(lines(good)[0]).versionId as string;
    const rogue = await w.entry((s) => { s.asset.name = 'rogue'; s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: genesis, push: false, ref: w.author.ref('key-1', v1) });
    const chain = new Chain();
    chain.publish(SAT, publication({ entries: [genesis, trueAnchor] }));
    chain.publish(SAT, publication({ entries: [genesis, rogue] }));
    const corrupt = corruptAt(good, 2);
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: corrupt }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'undetermined', outcome: 'incomplete', identity: 'incomplete' });
    expect(r.bitcoin).toBeUndefined();
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', rule: 'P5.6', item: { kind: 'signer', id: w.author.did } }));
    expect(r.entries.some((e) => e.status === 'rejected')).toBe(false);
    expect(labelOf(r, rogue)).toBeUndefined();
    // With the good log beside the corrupt one, in either order, the true anchor is the anchor and the rogue is not.
    for (const order of [[good, corrupt], [corrupt, good]]) {
      const both = await verifyOriginal(chain.evidence(w.did, { histories: order.map((log, k) => ({ did: w.author.did, log, source: `host-${k}` })) }));
      expect(axes(both)).toMatchObject({ bitcoin: 'anchored', outcome: 'verified' });
      expect(both.checkpoint).toBe(trueAnchor.versionId);
    }
  });

  test('a corrupt log does not verify the entries naming v1, on Bitcoin or off it: missing, never verified', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }); // names v1
    const log = w.author.log();
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]);
    const corrupt = corruptAt(w.author.log(), 2);
    expect(lines(corrupt)[0]).toBe(lines(log)[0]); // v1 itself is intact
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: corrupt }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'undetermined', outcome: 'incomplete' });
    expect(r.entries.some((e) => e.status === 'accepted')).toBe(false);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', item: { kind: 'signer', id: w.author.did } }));
    // Off Bitcoin: the same log as a copy, the corrupt history only.
    const off = await w.verify({ histories: [{ did: w.author.did, log: corrupt }] });
    expect(off.entries.every((e) => e.status === 'unchecked')).toBe(true);
    expect(axes(off)).toMatchObject({ identity: 'incomplete', outcome: 'incomplete' });
    expect(off.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', item: { kind: 'signer', id: w.author.did } }));
  });

  test('forked signer logs A and B, supplied in either order, give the same report; latestVersionId is chosen by number, then versionId', async () => {
    const w = await World.create();
    const { logA, logB, v2a, v2b, kA } = await forkedAuthor(w);
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { ref: refAt(w, 'key-a', v2a), key: kA });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const run = (order: Array<[string, string]>) => verifyOriginal(chain.evidence(w.did, { histories: order.map(([log, source]) => ({ did: w.author.did, log, source })) }));
    const ab = await run([[logA, 'host-a'], [logB, 'host-b']]);
    const ba = await run([[logB, 'host-b'], [logA, 'host-a']]);
    expect(normal(ba)).toEqual(normal(ab));
    expect(axes(ab)).toMatchObject({ bitcoin: 'anchored', outcome: 'verified' });
    expect(ab.checkpoint).toBe(anchor.versionId);
    const [newest, source] = v2a < v2b ? [v2a, 'host-a'] : [v2b, 'host-b'];
    expect(ab.signers).toEqual([{ did: w.author.did, role: 'author', latestVersionId: newest, source, obtained: '2026-11-20T00:00:00Z', freshness: 'not-established' }]);
    // Off Bitcoin as well.
    const offAB = await w.verify({ histories: [{ did: w.author.did, log: logA, source: 'host-a' }, { did: w.author.did, log: logB, source: 'host-b' }] });
    const offBA = await w.verify({ histories: [{ did: w.author.did, log: logB, source: 'host-b' }, { did: w.author.did, log: logA, source: 'host-a' }] });
    expect(normal(offBA)).toEqual(normal(offAB));
    expect(labelOf(offAB, anchor)?.status).toBe('unchecked'); // the anchoring entry, read without the anchor (P7.14)
    expect(offAB.entries.some((e) => e.status === 'rejected')).toBe(false);
  });

  test('a fork where only the other branch is supplied: signer-version-missing, never a rejection (anchoring publication, later publication, and off Bitcoin)', async () => {
    const w = await World.create();
    const { logB, v2a, kA } = await forkedAuthor(w);
    const named = await w.entry((s) => { s.asset.name = 'by key-a'; }, { ref: refAt(w, 'key-a', v2a), key: kA });
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { ref: refAt(w, 'key-a', v2a), key: kA });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: logB }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'undetermined', identity: 'incomplete', outcome: 'incomplete' });
    expect(r.entries.some((e) => e.status === 'rejected')).toBe(false);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-version-missing', rule: 'P7.8', item: { kind: 'signer', id: w.author.did, versionId: v2a } }));
    const off = await w.verify({ histories: [{ did: w.author.did, log: logB }] });
    expect(labelOf(off, named)).toEqual({ versionId: named.versionId, status: 'unchecked' });
    expect(off.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-version-missing', item: { kind: 'signer', id: w.author.did, versionId: v2a } }));
    expect(axes(off).identity).toBe('incomplete');
  });

  test('a later publication naming a version only the unsupplied branch holds is unverifiable, and the next one waits on it', async () => {
    const w = await World.create();
    const anchor = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }); // names v1
    const { logB, v2a, kA } = await forkedAuthor(w);
    const e = await w.entry((s) => { s.asset.name = 'on branch a'; }, { parent: anchor, push: false, ref: refAt(w, 'key-a', v2a), key: kA });
    const next = await w.entry((s) => { s.asset.name = 'next'; }, { parent: e, push: false, ref: w.author.ref('key-1', JSON.parse(lines(logB)[0]).versionId) });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w, { entries: w.entries.slice(0, 2) }));
    const [u] = chain.publish(SAT, publication({ entries: [e] }));
    const [n] = chain.publish(SAT, publication({ entries: [next] }));
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: logB }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'anchored', state: 'current' });
    expect(r.checkpoint).toBe(anchor.versionId);
    expect(r.bitcoin?.unverifiable).toEqual([{ inscription: u, did: w.author.did, versionId: v2a }]);
    expect(r.bitcoin?.waiting).toEqual([{ inscription: n, waitsOn: u }]);
    expect(r.entries.some((x) => x.status === 'rejected')).toBe(false);
  });
});

describe('owner decision A: other sats never block the anchor', () => {
  test('another did:og whose anchoring publication cannot be decided, on an unrelated sat and earlier, leaves ours anchored', async () => {
    const other = await World.create();
    await other.entry((s) => { s.asset.aliases = [SAT2]; s.asset.body = 'none'; });
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT2, publication({ entries: other.entries })); // its author's log is never supplied
    chain.publish(SAT, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did, { originalsIndex: { name: 'og-index', through: 300 } }));
    expect(axes(r)).toMatchObject({ bitcoin: 'anchored', outcome: 'verified', state: 'current' });
    expect(r.bitcoin?.sat).toBe(SAT);
    expect(r.bitcoin?.unverifiable).toEqual([]);
    expect(r.bitcoin?.holder.uniqueness).toEqual({ 'established-through': 300 });
    expect(r.diagnostics.some((d) => d.code === 'signer-history-missing' || d.code === 'anchoring-sat-not-read')).toBe(false);
  });

  test('T9-145(a): the same did:og undecidable on another sat, earlier than our valid anchor, is ignored: ours is anchored, nothing listed, uniqueness provisional', async () => {
    const w = await World.create();
    const genesis = w.head;
    const v1 = w.author.ref().versionId;
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]); // v2, not in the supplied log
    const early = await w.entry((s) => { s.asset.aliases = [SAT2]; s.asset.body = 'none'; }, { parent: genesis, push: false }); // names v2
    const ours = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: genesis, push: false, ref: w.author.ref('key-1', v1) });
    const chain = new Chain();
    const [e1] = chain.publish(SAT2, publication({ entries: [genesis, early] }), { height: 150 });
    chain.publish(SAT, publication({ entries: [genesis, ours] }), { height: 160 });
    chain.height = 170;
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: lines(w.author.log())[0] + '\n' }], originalsIndex: { name: 'og-index', through: 165 } }));
    expect(axes(r)).toMatchObject({ bitcoin: 'anchored', outcome: 'verified', state: 'current' });
    expect(r.bitcoin?.sat).toBe(SAT);
    expect(r.checkpoint).toBe(ours.versionId);
    expect(r.bitcoin?.unverifiable).toEqual([]);
    expect(r.bitcoin?.conflictingAnchors).toEqual([]);
    expect(r.bitcoin?.holder.uniqueness).toBe('provisional');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['resource-missing']);
    // Once its signer's log is supplied, the earlier one verifies: it is the anchor and ours a conflicting anchor.
    const full = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: w.author.log() }] }));
    expect(full.bitcoin?.sat).toBe(SAT2);
    expect(full.bitcoin?.conflictingAnchors.map((x) => x.sat)).toEqual([SAT]);
  });

  test('T9-077, T9-147: on the same sat, an earlier undecidable anchoring publication still leaves ours undetermined, of this did:og or another', async () => {
    const w = await World.create();
    const genesis = w.head;
    const v1 = w.author.ref().versionId;
    await web(w).rotate([{ fragment: 'key-1', signer: w.author.key }]);
    const early = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: genesis, push: false }); // names v2
    const ours = await w.entry((s) => { s.asset.name = 'b'; s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { parent: genesis, push: false, ref: w.author.ref('key-1', v1) });
    const v1Log = lines(w.author.log())[0] + '\n';
    const chain = new Chain();
    chain.publish(SAT, publication({ entries: [genesis, early] }));
    chain.publish(SAT, publication({ entries: [genesis, ours] }));
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: w.author.did, log: v1Log }] }));
    expect(axes(r).bitcoin).toBe('undetermined');
    expect(r.diagnostics.some((d) => d.code === 'anchoring-sat-not-read')).toBe(false);

    // Another did:og's undecidable anchoring publication first on our sat: ours there is undetermined.
    const other = await World.create();
    await other.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const mine = await World.create();
    await mine.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const c2 = new Chain();
    c2.publish(SAT, publication({ entries: other.entries }));
    c2.publish(SAT, anchoring(mine));
    const blocked = await verifyOriginal(c2.evidence(mine.did, { histories: [{ did: mine.author.did, log: mine.author.log() }] }));
    expect(axes(blocked)).toMatchObject({ bitcoin: 'undetermined', outcome: 'incomplete' });
    expect(blocked.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', item: { kind: 'signer', id: other.author.did } }));
    expect(blocked.diagnostics.some((d) => d.code === 'anchoring-sat-not-read')).toBe(false);
    // With a valid anchoring publication of a third did:og between them, the sat is taken whichever it is: ours is not anchored.
    const third = await World.create();
    await third.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const c3 = new Chain();
    c3.publish(SAT, publication({ entries: other.entries }));
    c3.publish(SAT, publication({ entries: third.entries }));
    c3.publish(SAT, anchoring(mine));
    const taken = await verifyOriginal(c3.evidence(mine.did, { histories: [{ did: mine.author.did, log: mine.author.log() }, { did: third.author.did, log: third.author.log() }] }));
    expect(axes(taken).bitcoin).toBe('not-anchored');
  });
});

describe('finding C: no anchoring-sat-not-read for a sat read in full', () => {
  test('an undetermined anchoring publication on a sat read in full: undetermined, with no anchoring-sat-not-read', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const copy = { kind: 'log' as const, source: 'copy', bytes: enc(serializeLog(w.entries)) };
    for (const extra of [[], [copy]]) {
      const r = await verifyOriginal(chain.evidence(w.did, { histories: false, extra }));
      expect(axes(r)).toMatchObject({ bitcoin: 'undetermined', outcome: 'incomplete' });
      expect(r.diagnostics.map((d) => d.code)).not.toContain('anchoring-sat-not-read');
      expect(r.diagnostics.map((d) => d.code)).toContain('signer-history-missing');
    }
  });
});

describe('finding E: a rejected anchoring publication with no anchor', () => {
  test('an anchoring publication whose metadata has an unknown member: its entries rejected under P14.12, outcome invalid (T14-003)', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const { encodeCbor } = await import('../src/originals/cbor.js');
    const { encodeEnvelope } = await import('../src/og/index.js');
    const chain = new Chain().supply(history(w.author));
    chain.inscribe(SAT, [encodeEnvelope({ metadata: encodeCbor({ entries: w.entries, extra: 1 } as never), body: null })]);
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ outcome: 'invalid', history: 'invalid', bitcoin: 'not-anchored' });
    expect(r.entries).toEqual(w.entries.map((e: OgEntry) => ({ versionId: e.versionId, status: 'rejected', rule: 'P14.12' })));
    expect(r.diagnostics.filter((d) => d.code === 'entry-rejected').length).toBe(w.entries.length);
  });

  test('an anchoring publication whose proof fails at the named version, with no anchor: identity failed, outcome invalid', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { key: seeded(303) });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ outcome: 'invalid', identity: 'failed', bitcoin: 'not-anchored' });
    expect(labelOf(r, w.head)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
  });

  test('a rejected anchoring publication before a valid anchor is not labelled: the valid one is the anchor (P9.16)', async () => {
    const w = await World.create();
    const genesis = w.head;
    const bad = await w.entry((s) => { s.asset.name = 'bad'; s.asset.aliases = [SAT]; s.asset.body = 'none'; }, { push: false, key: seeded(304) });
    const good = await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, publication({ entries: [genesis, bad] }, [history(w.author)]));
    chain.publish(SAT, publication({ entries: [genesis, good] }));
    const r = await verifyOriginal(chain.evidence(w.did));
    expect(axes(r)).toMatchObject({ outcome: 'verified', bitcoin: 'anchored' });
    expect(labelOf(r, bad)).toBeUndefined();
  });

  test('did:vh logs follow the same union rule: a corrupt copy beside a good one is ignored, in either order', async () => {
    const vh = await vhSigner();
    const w = await World.create(vh);
    await w.entry((s) => { s.asset.aliases = [SAT]; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish(SAT, anchoring(w));
    const good = vh.log();
    const r = await verifyOriginal(chain.evidence(w.did, { histories: [{ did: vh.did, log: good, source: 'a' }, { did: vh.did, log: good.replace('"versionTime":"', '"versionTime":"x'), source: 'b' }] }));
    expect(axes(r)).toMatchObject({ bitcoin: 'anchored', outcome: 'verified' });
    expect(r.signers?.[0]).toMatchObject({ source: 'a' });
  });
});
