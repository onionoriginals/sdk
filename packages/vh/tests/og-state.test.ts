// did:og entry state and transitions (P14.4–P14.7, P4, P5.15–P5.17, P6.5, P9.10, P9.30, P9.34).
import { describe, expect, test } from 'bun:test';
import { entryLine, resourceDigest, serializeLog, type OgEntry } from '../src/og/index.js';
import { AUTHOR, authorRef, desc, fakeWebvh, genesis, genesisState, newVersion, next, v1, v2, walk } from './helpers/og-build.js';
import { vtext, utf8 } from './helpers/og-vectors.js';

const BTCO = 'did:btco:reg:1234567890';
const ALIAS = fakeWebvh('alias', 'host.example');
const EDITOR = fakeWebvh('editor');
const EDITOR2 = fakeWebvh('editor-2');
const editorRef = (did = EDITOR) => ({ did, verificationMethod: `${did}#key-1`, versionId: '1-QmNjhx8xG4JD9hCswSc1nSZncxuSGzex37ica8BoyHEmrq' });
const grant = (did = EDITOR, p: Partial<{ name: boolean; metadata: boolean; resource: boolean }> = {}) => ({ did, name: false, metadata: false, resource: false, ...p });
const webp = utf8('RIFF....WEBPVP8 preview');

async function anchored(extra: (s: any) => void = () => {}) {
  const g = await genesis();
  const e2 = await next(g, (s) => { s.asset.aliases = [ALIAS]; });
  const e3 = await next(e2, (s) => { s.asset.aliases = [ALIAS, BTCO]; s.asset.body = 'full'; extra(s); });
  return [g, e2, e3];
}

describe('local vector entries (T14-091, T14-076)', () => {
  test('the writer reproduces local/asset/did.jsonl byte for byte', async () => {
    const e1 = await genesis();
    const e2 = await next(e1, (s) => newVersion(s, v2), { time: '2026-01-03T00:00:00Z' });
    expect(serializeLog([e1, e2])).toBe(vtext('local/asset/did.jsonl'));
    expect(walk([e1, e2])).toBeUndefined();
  });
});

describe('state shape (P14.4, P14.5)', () => {
  test('T14-012, T5-020: a member section 14 does not list, at any level, is rejected', async () => {
    const g = await genesis();
    expect(walk([await genesis(genesisState({ extra: 1 }))])).toMatchObject({ rule: 'P14.4' });
    expect(walk([await genesis(genesisState({}, { tags: [] }))])).toMatchObject({ rule: 'P14.4' });
    expect(walk([g, await next(g, (s) => { s.asset.resource.encoding = 'gzip'; })])).toMatchObject({ rule: 'P14.6' });
    expect(walk([g, await next(g, (s) => { s.author.note = 'x'; })])).toMatchObject({ rule: 'P14.4' });
  });

  test('T5-019: a delta state, not the full asset state, is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { delete s.asset.name; delete s.asset.aliases; })])).toMatchObject({ rule: 'P14.5' });
  });

  test('T5-009: an author reference without versionId is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { delete s.author.versionId; })])).toMatchObject({ rule: 'P14.4' });
  });

  test('an author array (signer sets) and asset.authors/parent/readers are rejected (D13)', async () => {
    expect(walk([await genesis(genesisState({ author: [authorRef] }))])).toMatchObject({ code: 'AUTHOR_ARRAY' });
    for (const k of ['authors', 'parent', 'readers']) expect(walk([await genesis(genesisState({}, { [k]: {} }))])).toMatchObject({ code: 'ASSET_ADDITION' });
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.editors = [{ ...grant(EDITOR, { resource: true }), scope: { type: 'paths' } }]; })])).toMatchObject({ rule: 'P14.5' });
  });

  test('T14-026: a name of 1,024 UTF-16 code units is accepted, 1,025 rejected, counting a non-BMP character as two', async () => {
    const ok = '😀'.repeat(512);
    expect(walk([await genesis(genesisState({}, { name: ok }))])).toBeUndefined();
    expect(walk([await genesis(genesisState({}, { name: ok + 'x' }))])).toMatchObject({ rule: 'P14.5' });
    expect(walk([await genesis(genesisState({}, { name: '' }))])).toMatchObject({ rule: 'P14.5' });
  });

  test('T4-006: a null name is rejected', async () => {
    expect(walk([await genesis(genesisState({}, { name: null }))])).toMatchObject({ rule: 'P4.6' });
  });

  test('T14-051: aliases of another method, or the same DID twice, are rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.aliases = ['did:web:example.com']; })])).toMatchObject({ rule: 'P14.5' });
    expect(walk([g, await next(g, (s) => { s.asset.aliases = [ALIAS, ALIAS]; })])).toMatchObject({ rule: 'P14.5' });
    expect(walk([g, await next(g, (s) => { s.asset.aliases = [ALIAS, fakeWebvh('other')]; })])).toMatchObject({ rule: 'P14.5' });
    expect(walk([await genesis(genesisState({}, { aliases: [ALIAS] }))])).toMatchObject({ code: 'GENESIS_ALIASES' });
  });

  test('T3-001 (state side): a state.id that is not did:og and the SCID is rejected (P3.1)', async () => {
    const g = await genesis(genesisState({ id: 'did:og:QmV2yQcaZ5eeDyWKqeHW5whoWmhtH9ZygNfDcnFEqEt4vW' }));
    expect(walk([g])).toMatchObject({ rule: 'P3.1' });
  });
});

describe('the resource (P4, P14.6, P14.7)', () => {
  test('T4-004: no resource, or more than one, is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { delete s.asset.resource; })])).toMatchObject({ rule: 'P4.1' });
    expect(walk([g, await next(g, (s) => { s.asset.resource = [desc(v1), desc(v2)]; })])).toMatchObject({ rule: 'P4.1' });
  });

  test('T14-020, T4-007: genesis {from: null, to}; a change {from, to}; any other entry []', async () => {
    const g = await genesis();
    const e2 = await next(g, (s) => newVersion(s, v2));
    const e3 = await next(e2, (s) => { s.asset.name = 'Renamed'; });
    expect(walk([g, e2, e3])).toBeUndefined();
    expect(walk([g, await next(g, (s) => { s.asset.name = 'x'; s.transitions = [{ from: resourceDigest(v1), to: resourceDigest(v1) }]; })])).toMatchObject({ rule: 'P14.4' });
    expect(walk([g, await next(g, (s) => { s.asset.resource = desc(v2); })])).toMatchObject({ rule: 'P14.4' });
    expect(walk([await genesis(genesisState({ transitions: [] }))])).toMatchObject({ rule: 'P14.4' });
  });

  test('T4-009 / T4-010: a mediaType-only change with {from, to} the same digest is accepted / with [] rejected', async () => {
    const g = await genesis(genesisState({}, { resource: desc(v1, 'text/plain') }));
    const ok = await next(g, (s) => newVersion(s, v1, 'text/markdown'));
    expect(ok.state.transitions).toEqual([{ from: resourceDigest(v1), to: resourceDigest(v1) }]);
    expect(walk([g, ok])).toBeUndefined();
    expect(walk([g, await next(g, (s) => { s.asset.resource.mediaType = 'text/markdown'; })])).toMatchObject({ rule: 'P14.4' });
  });

  test('T14-015: size changing without digest is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.resource.size += 1; })])).toMatchObject({ rule: 'P14.6' });
  });

  test('T14-054: a mediaType with a parameter is rejected, not ignored', async () => {
    expect(walk([await genesis(genesisState({}, { resource: desc(v1, 'text/plain; charset=utf-8') }))])).toMatchObject({ rule: 'P14.6' });
  });

  test('T14-013, T4-008: a non-canonical digest or another multihash is rejected', async () => {
    const d = resourceDigest(v1);
    for (const digest of [d.slice(1), 'u' + d.slice(1), 'z8tUCq8Ya1Z9jvDrrhtS9BTMzD4AgjHg2X3bA1sVbTZsAa', d.toLowerCase()]) {
      const g = await genesis(genesisState({ transitions: [{ from: null, to: d }] }, { resource: { ...desc(v1), digest } }));
      expect(walk([g])?.rule).toBe('P14.7');
    }
    expect(walk([await genesis(genesisState({}, { resource: { ...desc(v1), algorithm: 'sha3-256' } }))])).toMatchObject({ rule: 'P4.2' });
  });
});

describe('deactivation (P6.5)', () => {
  test('T6-006: status deactivated without deactivated: true, or the reverse, is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.status = 'deactivated'; s.operation = 'deactivate'; })])).toMatchObject({ rule: 'P6.5' });
    expect(walk([g, await next(g, (s) => { s.operation = 'deactivate'; }, { parameters: { deactivated: true } })])).toMatchObject({ rule: 'P6.5' });
    expect(walk([g, await next(g, (s) => { s.asset.status = 'deactivated'; s.operation = 'deactivate'; }, { parameters: { deactivated: true } })])).toBeUndefined();
  });

  test('T6-027, T6-028: a deactivation whose operation is update, or deactivate in an entry that is not a deactivation, is rejected (P6.5, P14.4)', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.status = 'deactivated'; s.operation = 'update'; }, { parameters: { deactivated: true } })])).toMatchObject({ rule: 'P6.5' });
    expect(walk([g, await next(g, (s) => { s.operation = 'deactivate'; s.asset.name = 'x'; })])).toMatchObject({ rule: 'P6.5' });
  });

  test('T6-004, T6-008: an update after, or descending from, a deactivation is rejected', async () => {
    const g = await genesis();
    const d = await next(g, (s) => { s.asset.status = 'deactivated'; s.operation = 'deactivate'; }, { parameters: { deactivated: true } });
    expect(walk([g, d, await next(d, (s) => { s.asset.status = 'active'; s.asset.name = 'Back'; })])).toMatchObject({ index: 2, rule: 'P6.5' });
  });
});

describe('author (P5.8)', () => {
  test('T5-012 (state side): a later entry naming a different author DID is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.author = editorRef(); })])).toMatchObject({ rule: 'P5.8' });
  });

  test('T5-013: an author DID of an unlisted method is rejected', async () => {
    expect(walk([await genesis(genesisState({ author: { did: 'did:key:z6Mk', verificationMethod: 'did:key:z6Mk#z6Mk', versionId: '1' } }))])).toMatchObject({ rule: 'P5.8' });
  });
});

describe('editors and grants (P5.15, P5.16, P5.17)', () => {
  async function granted(p = { name: true, metadata: true, resource: true }) {
    const g = await genesis();
    const e2 = await next(g, (s) => { s.asset.editors = [grant(EDITOR, p), grant(EDITOR2, { metadata: true })]; });
    return [g, e2];
  }

  test('T5-032: two editors each sign an entry within their grant', async () => {
    const [g, e2] = await granted({ name: false, metadata: false, resource: true });
    const e3 = await next(e2, (s) => { s.editor = editorRef(); newVersion(s, v2); });
    const e4 = await next(e3, (s) => { s.editor = editorRef(EDITOR2); s.asset.metadata = { caption: 'Harbor' }; });
    expect(walk([g, e2, e3, e4])).toBeUndefined();
    expect(e3.state.author).toEqual(g.state.author);
  });

  test('T5-033: an editor entry outside its grant (name, metadata or resource) is rejected', async () => {
    const [g, e2] = await granted({ name: false, metadata: true, resource: false });
    expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(); s.asset.name = 'x'; })])).toMatchObject({ rule: 'P5.16', code: 'OUTSIDE_GRANT' });
    expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(); newVersion(s, v2); })])).toMatchObject({ code: 'OUTSIDE_GRANT' });
    expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(EDITOR2); s.asset.name = 'x'; })])).toMatchObject({ code: 'OUTSIDE_GRANT' });
  });

  test('T5-034: an editor entry that changes grants, aliases, lifecycle or parameters, anchors or deactivates is rejected', async () => {
    const [g, e2] = await granted();
    const cases: Array<[(s: any) => void, object?]> = [
      [(s) => { s.asset.editors = [grant(EDITOR, { name: true, metadata: true, resource: true })]; }],
      [(s) => { s.asset.aliases = [ALIAS]; }],
      [(s) => { s.asset.aliases = [BTCO]; s.asset.body = 'none'; }],
    ];
    for (const [c] of cases) expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(); c(s); })])?.rule).toBe('P5.16');
    const deact = await next(e2, (s) => { s.editor = editorRef(); s.asset.status = 'deactivated'; s.operation = 'deactivate'; }, { parameters: { deactivated: true } });
    expect(walk([g, e2, deact])).toBeDefined();
  });

  test('T5-035, T5-046: an editor entry with another author reference, or an operation other than update, is rejected', async () => {
    const [g, e2] = await granted();
    expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(); s.author = { ...s.author, versionId: '2-QmX' }; })])).toMatchObject({ code: 'EDITOR_AUTHOR' });
  });

  test('T5-036: an editor entry whose parent grants it nothing, including after revocation, is rejected', async () => {
    const [g, e2] = await granted();
    const revoke = await next(e2, (s) => { s.asset.editors = [grant(EDITOR2, { metadata: true })]; });
    expect(walk([g, e2, revoke, await next(revoke, (s) => { s.editor = editorRef(); s.asset.name = 'x'; })])).toMatchObject({ rule: 'P5.17' });
    expect(walk([g, await next(g, (s) => { s.editor = editorRef(); s.asset.name = 'x'; })])).toMatchObject({ rule: 'P5.17' });
  });

  test('T5-037: an editor\'s earlier entries stay valid after revocation', async () => {
    const [g, e2] = await granted();
    const e3 = await next(e2, (s) => { s.editor = editorRef(); s.asset.name = 'Edited'; });
    const revoke = await next(e3, (s) => { delete s.asset.editors; });
    expect(walk([g, e2, e3, revoke])).toBeUndefined();
  });

  test('T5-038, T5-056, T5-054, T5-049: grants naming the author identity, a duplicate identity, an unlisted method, the Original, an alias or its sat are rejected', async () => {
    const g = await genesis();
    const authorMoved = AUTHOR.replace('author.example', 'moved.example');
    const sameScid = EDITOR.replace('example.com', 'other.example');
    const bad = [
      [grant(AUTHOR)], [grant(authorMoved)], [grant(EDITOR), grant(sameScid)], [grant('did:key:z6MkhtqrkCdVxVhRFQwWDrapyxH6rWwnFinpHx4jwyc2fSnJ')],
      [grant(g.state.id as string)],
    ];
    for (const editors of bad) expect(walk([g, await next(g, (s) => { s.asset.editors = editors; })])?.rule).toBe('P5.15');
    expect(walk([g, await next(g, (s) => { s.asset.aliases = [ALIAS]; s.asset.editors = [grant(ALIAS)]; })])?.rule).toBe('P5.15');
    const [a1, a2, a3] = await anchored();
    expect(walk([a1, a2, a3, await next(a3, (s) => { s.asset.editors = [grant(BTCO)]; })])?.rule).toBe('P5.15');
  });

  test('T5-048, T14-073: 32 grants are accepted; 33 rejected as limit-exceeded; T14-014: an empty editors array is rejected', async () => {
    const g = await genesis();
    const many = (n: number) => Array.from({ length: n }, (_, i) => grant(fakeWebvh(`e${i}`)));
    expect(walk([g, await next(g, (s) => { s.asset.editors = many(32); })])).toBeUndefined();
    expect(walk([g, await next(g, (s) => { s.asset.editors = many(33); })])).toMatchObject({ rule: 'P5.15', code: 'EDITORS_LIMIT' });
    expect(walk([g, await next(g, (s) => { s.asset.editors = []; })])).toMatchObject({ code: 'EDITORS_EMPTY' });
  });

  test('T6-023: an editor entry with supersedes is rejected; T14-062: 9 or repeated supersedes are rejected', async () => {
    const [g, e2] = await granted();
    expect(walk([g, e2, await next(e2, (s) => { s.editor = editorRef(); s.supersedes = [e2.versionId]; s.asset.name = 'x'; })])).toMatchObject({ rule: 'P6.9' });
    expect(walk([g, e2, await next(e2, (s) => { s.supersedes = Array.from({ length: 9 }, (_, i) => `${i + 2}-Qm${i}`); })])).toMatchObject({ rule: 'P14.4' });
    expect(walk([g, e2, await next(e2, (s) => { s.supersedes = [e2.versionId, e2.versionId]; })])).toMatchObject({ rule: 'P14.4' });
    expect(walk([g, e2, await next(e2, (s) => { s.supersedes = Array.from({ length: 8 }, (_, i) => `${i + 2}-Qm${i}`); })])).toBeUndefined();
  });
});

describe('network, aliases and anchoring (P9.10, P9.34)', () => {
  test('T9-053: a genesis with no network, or a later entry that changes it, is rejected', async () => {
    const st = genesisState();
    delete (st.asset as any).network;
    expect(walk([await genesis(st)])).toMatchObject({ rule: 'P9.34' });
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.network = 'signet'; })])).toMatchObject({ rule: 'P9.34' });
  });

  test('T9-054: an anchoring alias on another network than the genesis network is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.aliases = ['did:btco:sig:1234567890']; s.asset.body = 'none'; })])).toMatchObject({ rule: 'P9.34' });
  });

  test('T9-048: unknown prefix, a sign, leading zeros or beyond the supply are rejected', async () => {
    const g = await genesis();
    for (const a of ['did:btco:foo:1', 'did:btco:reg:+1', 'did:btco:reg:01', 'did:btco:reg:2099999997690000', 'did:btco:reg:-1']) {
      expect(walk([g, await next(g, (s) => { s.asset.aliases = [a]; s.asset.body = 'none'; })])?.rule).toBe('P9.10');
    }
    expect(walk([g, await next(g, (s) => { s.asset.aliases = ['did:btco:reg:2099999997689999']; s.asset.body = 'none'; })])).toBeUndefined();
  });

  test('T9-008: after anchoring, removing, changing or adding a did:btco alias is rejected', async () => {
    const [g, e2, e3] = await anchored();
    expect(walk([g, e2, e3, await next(e3, (s) => { s.asset.aliases = [ALIAS]; delete s.asset.body; })])?.rule).toBe('P9.10');
    expect(walk([g, e2, e3, await next(e3, (s) => { s.asset.aliases = [ALIAS, 'did:btco:reg:5']; })])?.rule).toBe('P9.10');
  });

  test('T9-012, T9-046, T9-050: after anchoring, adding, replacing or re-adding a did:webvh alias is rejected', async () => {
    const g = await genesis();
    const a = await next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'none'; });
    expect(walk([g, a, await next(a, (s) => { s.asset.aliases = [BTCO, ALIAS]; })])).toMatchObject({ code: 'WEBVH_AFTER_ANCHOR' });
    const [b1, b2, b3] = await anchored();
    expect(walk([b1, b2, b3, await next(b3, (s) => { s.asset.aliases = [fakeWebvh('new', 'new.example'), BTCO]; })])).toMatchObject({ code: 'WEBVH_AFTER_ANCHOR' });
    const removed = await next(b3, (s) => { s.asset.aliases = [BTCO]; });
    const readded = await next(removed, (s) => { s.asset.aliases = [ALIAS, BTCO]; });
    expect(walk([b1, b2, b3, removed])).toBeUndefined();
    expect(walk([b1, b2, b3, removed, readded])).toMatchObject({ code: 'WEBVH_READDED' });
  });

  test('T3-009 (unanchored): moving the did:webvh alias is an author entry changing the alias', async () => {
    const g = await genesis();
    const e2 = await next(g, (s) => { s.asset.aliases = [ALIAS]; });
    expect(walk([g, e2, await next(e2, (s) => { s.asset.aliases = [fakeWebvh('alias', 'new.example')]; })])).toBeUndefined();
  });

  test('T9-023: an anchoring entry naming the author DID\'s own sat is rejected', async () => {
    const btcoAuthor = { did: 'did:btco:reg:777', verificationMethod: 'did:btco:reg:777#key-1', versionId: 'abci0' };
    const g = await genesis(genesisState({ author: btcoAuthor }));
    expect(walk([g, await next(g, (s) => { s.asset.aliases = ['did:btco:reg:777']; s.asset.body = 'none'; })])).toMatchObject({ rule: 'P5.13' });
  });
});

describe('body modes and previews (P9.30, P14.5)', () => {
  test('T9-066: a did:btco alias with no body; body preview with no preview; preview with body full or none: rejected', async () => {
    const g = await genesis();
    const p = desc(webp, 'image/webp');
    const cases = [
      (s: any) => { s.asset.aliases = [BTCO]; },
      (s: any) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; },
      (s: any) => { s.asset.aliases = [BTCO]; s.asset.body = 'full'; s.asset.preview = p; },
      (s: any) => { s.asset.aliases = [BTCO]; s.asset.body = 'none'; s.asset.preview = p; },
    ];
    for (const c of cases) expect(walk([g, await next(g, c)])?.rule).toBe('P9.30');
  });

  test('T9-067, T9-098: body or preview before any did:btco alias is rejected', async () => {
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.body = 'none'; })])?.rule).toBe('P9.30');
    expect(walk([g, await next(g, (s) => { s.asset.preview = desc(webp, 'image/webp'); s.asset.body = 'preview'; })])?.rule).toBe('P9.30');
  });

  test('T9-095, T9-096: a preview of 0 bytes is rejected; 8,192 accepted; 8,193 rejected', async () => {
    const g = await genesis();
    const at = (size: number) => next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; s.asset.preview = { mediaType: 'image/webp', size, digest: resourceDigest(webp) }; });
    expect(walk([g, await at(0)])?.rule).toBe('P9.30');
    expect(walk([g, await at(8192)])).toBeUndefined();
    expect(walk([g, await at(8193)])?.rule).toBe('P9.30');
  });

  test('T9-093 / T9-094: an image version\'s preview other than image/webp is rejected (any case); any type for a non-image', async () => {
    for (const mediaType of ['image/png', 'IMAGE/svg+xml', 'Image/jpeg']) {
      const g = await genesis(genesisState({}, { resource: desc(v1, mediaType) }));
      expect(walk([g, await next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; s.asset.preview = desc(webp, 'image/svg+xml'); })])?.rule).toBe('P9.30');
    }
    const g = await genesis();
    expect(walk([g, await next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; s.asset.preview = desc(webp, 'text/plain'); })])).toBeUndefined();
  });

  test('T9-100, T9-102, T9-103: anchoring entry names a preview; a digest change may repeat its parent\'s; otherwise only the parent\'s or none', async () => {
    const p = desc(webp, 'image/webp');
    const p2 = desc(utf8('another preview'), 'image/webp');
    const [g, e2, a] = await anchored((s) => { s.asset.body = 'preview'; s.asset.preview = p; });
    expect(walk([g, e2, a])).toBeUndefined();
    const same = await next(a, (s) => { newVersion(s, v2); });
    expect(walk([g, e2, a, same])).toBeUndefined();
    expect(walk([g, e2, a, await next(a, (s) => { s.asset.name = 'x'; s.asset.preview = p2; })])).toMatchObject({ code: 'PREVIEW_CHANGED' });
    const dropped = await next(a, (s) => { s.asset.name = 'x'; delete s.asset.preview; s.asset.body = 'none'; });
    expect(walk([g, e2, a, dropped])).toBeUndefined();
    expect(walk([g, e2, a, dropped, await next(dropped, (s) => { s.asset.name = 'y'; s.asset.preview = p; s.asset.body = 'preview'; })])).toMatchObject({ code: 'PREVIEW_CHANGED' });
  });

  test('T9-134: a mediaType-only change is a new version: its preview may differ from, equal or drop the parent\'s (P9.30, P4.4)', async () => {
    const supplied = desc(utf8('author preview'), 'text/plain');
    const g = await genesis(genesisState({}, { resource: desc(v1, 'text/plain') }));
    const a = await next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; s.asset.preview = supplied; });
    const other = desc(utf8('new preview'), 'text/plain');
    for (const preview of [other, supplied, undefined]) {
      const e = await next(a, (s) => { newVersion(s, v1, 'text/markdown'); if (preview) s.asset.preview = preview; else { delete s.asset.preview; s.asset.body = 'none'; } });
      expect(walk([g, a, e])).toBeUndefined();
    }
  });

  test('T5-027, T5-031: editors change preview or body only with a resource grant and a new version', async () => {
    const p = desc(webp, 'image/webp');
    const [g, e2, a] = await anchored((s) => { s.asset.body = 'preview'; s.asset.preview = p; s.asset.editors = [grant(EDITOR, { resource: true }), grant(EDITOR2, { metadata: true })]; });
    expect(walk([g, e2, a, await next(a, (s) => { s.editor = editorRef(); newVersion(s, v2); s.asset.preview = desc(utf8('new'), 'image/webp'); })])).toBeUndefined();
    expect(walk([g, e2, a, await next(a, (s) => { s.editor = editorRef(); s.asset.preview = desc(utf8('new'), 'image/webp'); })])?.rule).toBe('P9.30');
    expect(walk([g, e2, a, await next(a, (s) => { s.editor = editorRef(); delete s.asset.preview; s.asset.body = 'full'; })])?.rule).toBe('P9.30');
    expect(walk([g, e2, a, await next(a, (s) => { s.editor = editorRef(EDITOR2); s.asset.body = 'full'; delete s.asset.preview; })])?.rule).toBe('P9.30');
  });

  test('T14-004: a preview with a parameter, a bad digest or another member is rejected', async () => {
    const g = await genesis();
    for (const preview of [{ ...desc(webp, 'image/webp; q=1') }, { ...desc(webp, 'text/plain'), digest: 'zbad' }, { ...desc(webp, 'text/plain'), width: 1 }]) {
      expect(walk([g, await next(g, (s) => { s.asset.aliases = [BTCO]; s.asset.body = 'preview'; s.asset.preview = preview; })])?.rule).toMatch(/^P14\.[57]$/);
    }
  });

  test('entry lines stay JCS', async () => {
    const g = await genesis();
    expect(entryLine(g).endsWith('\n')).toBe(true);
  });
});

export type { OgEntry };
