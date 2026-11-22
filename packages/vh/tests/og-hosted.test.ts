// did:og hosting (P6.7, P7.20, P3.6, P9.7, P14.11): the hosted vector and the host rows.
import { describe, expect, test } from 'bun:test';
import { checkAlias, hostedFiles, hostedLayout, memoryHostStore, parseLogFile, resourceDigest, resourceHeaders, SharedHost, verifyOriginal, type OgEntry, type Submission } from '../src/og/index.js';
import { bytesEqual, utf8, vbytes, vjson, vtext, vtree } from './helpers/og-vectors.js';
import { seeded, WebvhAuthor } from './helpers/originals.js';
import { axes, enc, labelOf, res, webvhSigner, World } from './helpers/og-world.js';
import { serializeLog } from '../src/og/index.js';

const OG = vjson('index.json').original as string;
const AUTHOR = vjson('index.json').author as string;

async function vectorHost() {
  const store = memoryHostStore();
  const lines = vtext('local/asset/did.jsonl');
  await store.createLog(OG, lines);
  await store.putIdentity(AUTHOR, vtext('local/author/did.jsonl'));
  return { store, host: new SharedHost(store) };
}

describe('hosted vector (T14-079, T14-063, P14.11)', () => {
  test('the shared-host saves in exchanges.json give accepted, stale-parent with the new head, already-accepted', async () => {
    const { store, host } = await vectorHost();
    const ex = vjson('hosted/exchanges.json');
    const head = (parseLogFile(vtext('local/asset/did.jsonl')).values as OgEntry[])[1].versionId;
    expect(head).toBe(ex.initialHead);
    for (const { request, response } of ex.exchanges) {
      expect(await host.submit(request as Submission)).toEqual(response);
    }
    // The host stored the accepted line byte for byte, and published nothing refused.
    expect(store.logs.get(OG)).toBe(vtext('hosted/served/originals/asset/did.jsonl'));
  });

  test('the served files are the alias log and the package unpacked under originals/', () => {
    const served = vtree('hosted/served');
    const v1 = vbytes('local/resources/v1.md'), v2 = vbytes('local/resources/v2.md');
    const files = hostedFiles({
      aliasLog: served['did.jsonl'], original: OG, assetLog: served['originals/asset/did.jsonl'],
      signers: [{ did: AUTHOR, log: vbytes('local/author/did.jsonl') }], resources: { [resourceDigest(v1)]: v1, [resourceDigest(v2)]: v2 },
    });
    expect(Object.keys(files).sort()).toEqual(Object.keys(served).sort());
    for (const [k, v] of Object.entries(files)) expect(bytesEqual(v, served[k])).toBe(true);
  });

  test('the layout and the resource headers are the vector\'s (P9.7)', () => {
    const layout = vjson('hosted/layout.json');
    const v1 = vbytes('local/resources/v1.md'), v2 = vbytes('local/resources/v2.md');
    const { note: _n, ...want } = layout;
    expect(hostedLayout(layout.alias, [v1, v2].map((b) => ({ digest: resourceDigest(b), mediaType: 'text/markdown' })))).toEqual(want);
  });

  test('T3-006/P3.6: the vector alias points to the did:og and entry 3 lists it, so it is confirmed', async () => {
    const log = parseLogFile(vtext('hosted/served/originals/asset/did.jsonl')).values as OgEntry[];
    const c = await checkAlias(vtext('hosted/served/did.jsonl'), OG, log[2]);
    expect(c).toMatchObject({ alias: vjson('index.json').alias, confirmed: true });
    // T3-004: listed by the state, but the state at entry 2 does not list it yet.
    expect((await checkAlias(vtext('hosted/served/did.jsonl'), OG, log[1])).confirmed).toBe(false);
  });

  test('T14-063: the served package verifies as the package, found from the alias', async () => {
    const served = vtree('hosted/served/originals');
    const inputs = Object.entries(served).filter(([n]) => n.startsWith('resources/')).map(([n, b]) => ({ kind: 'resource' as const, source: `https://host.example/field-notes/originals/${n}`, bytes: b }));
    const r = await verifyOriginal({
      original: OG,
      inputs: [
        { kind: 'log', source: 'https://host.example/field-notes/originals/asset/did.jsonl', bytes: served['asset/did.jsonl'] },
        { kind: 'signer-history', source: 'https://host.example/field-notes/originals/signers/…/did.jsonl', bytes: vbytes('local/author/did.jsonl'), did: AUTHOR },
        ...inputs,
      ],
    });
    expect(axes(r)).toMatchObject({ outcome: 'verified', state: 'valid-as-of', availability: 'complete', offline: 'needs-external' });
    expect(r.checkpoint).toBe(vjson('index.json').entries.e3);
  });
});

describe('alias rows (§3)', () => {
  async function alias(original: string, aka: string[]) {
    const a = await WebvhAuthor.create([{ fragment: 'k', signer: seeded(150) }], { domain: 'alias.example.com', alsoKnownAs: aka });
    return { did: a.did, log: (await import('../src/log/index.js')).serializeLog(a.entries), a };
  }

  test('T3-003: a did:webvh whose document points to a did:og that does not list it is not an alias', async () => {
    const w = await World.create();
    const al = await alias(w.did, [w.did]);
    expect((await checkAlias(al.log, w.did, w.head)).confirmed).toBe(false);
  });

  test('T3-004, T3-011: a listed alias whose document points elsewhere, or stops listing the did:og, is not confirmed; the did:og still verifies', async () => {
    const w = await World.create();
    const al = await alias(w.did, ['did:og:QmOther']);
    await w.entry((s) => { s.asset.aliases = [al.did]; });
    expect((await checkAlias(al.log, w.did, w.head)).confirmed).toBe(false);
    expect(axes(await w.verify()).outcome).toBe('verified');
  });
});

describe('host rows (§6, §7, §9)', () => {
  async function hosted() {
    const w = await World.create();
    const store = memoryHostStore();
    await store.createLog(w.did, serializeLog(w.entries));
    await store.putIdentity(w.author.did, w.author.log());
    return { w, store, host: new SharedHost(store) };
  }
  const submit = (w: World, e: OgEntry, extra: Partial<Submission> = {}): Submission => ({ original: w.did, entry: serializeLog([e]), resources: [], identities: [], ...extra });

  test('T6-010, T6-011: two submissions with one parent: one accepted, the other stale-parent with the new head; the reconciled candidate is accepted', async () => {
    const { w, host, store } = await hosted();
    const base = w.head;
    const a = await w.entry((s) => { s.asset.name = 'A'; }, { parent: base, push: false });
    const b = await w.entry((s) => { s.asset.name = 'B'; }, { parent: base, push: false });
    const [ra, rb] = await Promise.all([host.submit(submit(w, a)), host.submit(submit(w, b))]);
    expect(ra).toEqual({ result: 'accepted', checkpoint: a.versionId, head: a.versionId });
    expect(rb).toEqual({ result: 'stale-parent', head: a.versionId });
    expect(store.logs.get(w.did)).not.toContain(b.versionId);
    const reconciled = await w.entry((s) => { s.asset.name = 'B'; }, { parent: a, push: false });
    expect(await host.submit(submit(w, reconciled))).toMatchObject({ result: 'accepted' });
  });

  test('T6-013: a retry after a lost acknowledgement, after the head moved on, returns its checkpoint and the head', async () => {
    const { w, host } = await hosted();
    const a = await w.entry((s) => { s.asset.name = 'A'; });
    await host.submit(submit(w, a));
    const b = await w.entry((s) => { s.asset.name = 'B'; });
    await host.submit(submit(w, b));
    expect(await host.submit(submit(w, a))).toEqual({ result: 'already-accepted', checkpoint: a.versionId, head: b.versionId });
  });

  test('a submission that does not verify, or brings bytes that do not match, is refused and not stored', async () => {
    const { w, host, store } = await hosted();
    const mallory = await webvhSigner();
    const forged = await w.entry((s) => { s.asset.name = 'x'; }, { key: mallory.key, push: false });
    expect(await host.submit(submit(w, forged))).toMatchObject({ result: 'rejected', rule: 'P5.3' });
    const v2 = res('v2');
    const e = await w.entry((s) => w.version(s, v2), { push: false });
    expect(await host.submit(submit(w, e, { resources: [{ digest: resourceDigest(v2), bytes: res('other') }] }))).toMatchObject({ result: 'rejected', rule: 'P4.3' });
    expect(store.logs.get(w.did)!.split('\n').length).toBe(2);
    expect(await host.submit(submit(w, e, { resources: [{ digest: resourceDigest(v2), bytes: v2 }] }))).toMatchObject({ result: 'accepted' });
  });

  test('T7-052, T7-053: after a key removal, an editor entry extending an unendorsed entry is refused; a current-key author entry is accepted', async () => {
    const { w, host } = await hosted();
    const ed = await webvhSigner();
    const g = await w.entry((s) => { s.asset.editors = [{ did: ed.did, name: true, metadata: false, resource: false }]; });
    expect(await host.submit({ ...submit(w, g), identities: [{ did: ed.did, log: ed.log() }] })).toMatchObject({ result: 'accepted' });
    const k2 = seeded(160);
    await (w.author.handle as WebvhAuthor).rotate([{ fragment: 'key-2', signer: k2 }]);
    const identities = [{ did: w.author.did, log: w.author.log() }];
    const byEditor = await w.entry((s) => { s.asset.name = 'e'; }, { by: ed, editor: true, push: false });
    expect(await host.submit({ ...submit(w, byEditor), identities })).toMatchObject({ result: 'rejected', rule: 'P7.20' });
    const byAuthor = await w.entry((s) => { s.asset.name = 'a'; }, { ref: w.author.ref('key-2'), key: k2, push: false });
    expect(await host.submit({ ...submit(w, byAuthor), identities })).toMatchObject({ result: 'accepted' });
  });

  test('T9-026: SVG and HTML are served sandboxed, never sniffed; plain media types keep their type', () => {
    expect(resourceHeaders('image/svg+xml')).toMatchObject({ 'Content-Type': 'image/svg+xml', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': expect.stringContaining('sandbox') });
    expect(resourceHeaders('text/html')['Content-Security-Policy']).toContain('sandbox');
    expect(resourceHeaders('text/markdown')).toEqual({ 'Content-Type': 'text/markdown', 'X-Content-Type-Options': 'nosniff' });
  });

  test('T14-064, T9-003: the signed mediaType is used, never the served one; a mixed snapshot fails its digest', async () => {
    const w = await World.create();
    const v2 = res('v2');
    await w.entry((s) => w.version(s, v2));
    // A host serves v1's bytes where v2 should be (mixed snapshot); the served Content-Type is not an input at all.
    const e = w.evidence({ resources: [res('version 1')] });
    e.inputs.push({ kind: 'resource', source: `https://h.example/originals/resources/${resourceDigest(v2)}`, bytes: res('version 1') });
    const r = await verifyOriginal(e);
    expect(axes(r).availability).toBe('partial');
    expect(labelOf(r, w.head)).toMatchObject({ status: 'accepted' });
  });

  test('genesis submission to an empty host, and a second genesis is stale', async () => {
    const w = await World.create();
    const store = memoryHostStore();
    const host = new SharedHost(store);
    await store.putIdentity(w.author.did, w.author.log());
    expect(await host.submit(submit(w, w.entries[0], { resources: [{ digest: resourceDigest(res('version 1')), bytes: res('version 1') }] }))).toMatchObject({ result: 'accepted' });
    expect(await host.submit(submit(w, w.entries[0]))).toMatchObject({ result: 'already-accepted' });
    expect(utf8(store.logs.get(w.did)!)).toEqual(enc(serializeLog(w.entries)));
  });
});
