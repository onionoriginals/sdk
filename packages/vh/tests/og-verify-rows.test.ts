// did:og verifier rows off Bitcoin (section 12): signer binding (§5), operations and forks (§6),
// evidence and the report (§7), and the wire rows that need a verifier (§14).
import { describe, expect, test } from 'bun:test';
import { encodeMultikey, localSigner } from '../src/crypto/index.js';
import { serializeLog as serializeVh } from '../src/log/index.js';
import {
  buildPackage, checkAxes, defaultCheck, sameReport, deriveDocument, resourceDigest, serializeLog, verifyOriginal,
  type EvidenceSet, type Report,
} from '../src/og/index.js';
import { seeded, WebvhAuthor } from './helpers/originals.js';
import { axes, enc, labelOf, res, vhSigner, webvhSigner, World, type Signer } from './helpers/og-world.js';

const grant = (did: string, p: Partial<Record<'name' | 'metadata' | 'resource', boolean>> = {}) => ({ did, name: false, metadata: false, resource: false, ...p });
const web = (s: Signer) => s.handle as WebvhAuthor;

describe('identifiers (§3)', () => {
  test('T3-001: a wrong Original ID is unbound and invalid', async () => {
    const w = await World.create();
    const other = await World.create(w.author);
    const r = await verifyOriginal({ ...w.evidence(), original: other.did });
    expect(axes(r)).toMatchObject({ binding: 'unbound', outcome: 'invalid', state: 'none' });
  });

  test('T3-006, T14-017, T14-005: the derived DID document follows P14.9; a preview is not in it', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.aliases = ['did:btco:reg:5']; s.asset.body = 'preview'; s.asset.preview = { mediaType: 'image/webp', size: 3, digest: resourceDigest(enc('abc')) }; });
    expect(deriveDocument(e)).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'], id: w.did, controller: w.author.did, alsoKnownAs: ['did:btco:reg:5'],
      service: [{ id: `${w.did}#files`, type: 'OriginalsFiles', serviceEndpoint: (e.state.asset as any).resource }],
    });
    expect(deriveDocument(w.entries[0])).not.toHaveProperty('alsoKnownAs');
  });

  test('T3-010, T3-013: exact-checkpoint resolution of a checkpoint not in the evidence set: state none, outcome incomplete, target-missing', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.name = 'Two'; });
    const r = await w.verify({ checkpoint: '9-QmNotHere' });
    expect(r.checkpoint).toBeNull();
    expect(axes(r).state).toBe('none');
    expect(axes(r).outcome).toBe('incomplete');
    expect(r.diagnostics.filter((d) => d.code === 'target-missing').map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'target-missing', rule: 'P3.2', item: { kind: 'entry', id: '9-QmNotHere' } }]);
    expect(r).not.toHaveProperty('reason');
  });

  test('T7-076: an evidence set with the did:og and no log entry: state none, outcome incomplete, target-missing naming the did:og', async () => {
    const w = await World.create();
    const r = await verifyOriginal({ original: w.did, inputs: [] });
    // P7.18 (5281746, F16): with no log entry nothing contradicts the binding; target-missing carries the gap.
    expect(axes(r)).toMatchObject({ binding: 'bound', state: 'none', outcome: 'incomplete' });
    expect(r.diagnostics.map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'target-missing', rule: 'P3.2', item: { kind: 'entry', id: w.did } }]);
  });

  test('exact-checkpoint resolution of an earlier checkpoint reports that checkpoint, not the latest (P3.2)', async () => {
    const w = await World.create();
    const e1 = w.entries[0];
    await w.entry((s) => { s.asset.name = 'Two'; });
    const r = await w.verify({ checkpoint: e1.versionId });
    expect(r.checkpoint).toBe(e1.versionId);
    expect(r.entries?.map((e) => e.versionId)).toEqual([e1.versionId]);
  });
});

describe('the resource (§4)', () => {
  test('T4-001, T7-070: bytes changed at the same URL fail their digest: a resource-mismatch diagnostic, availability partial, needs-external', async () => {
    const w = await World.create();
    const v2 = res('version 2');
    await w.entry((s) => w.version(s, v2));
    const e = w.evidence({ resources: [res('version 1')] });
    // A package serving other bytes under v2's digest.
    const tampered = buildPackage({ original: w.did, assetLog: enc(serializeLog(w.entries)), versionIds: w.entries.map((x) => x.versionId), signers: [], resources: { [resourceDigest(v2)]: res('version X') }, missing: [] });
    e.inputs.push({ kind: 'package', source: 'host.zip', bytes: tampered.archive });
    const r = await verifyOriginal(e);
    expect(axes(r).availability).toBe('partial');
    expect(r.diagnostics.map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'resource-mismatch', rule: 'P7.4', item: { kind: 'resource', id: resourceDigest(v2), versionId: w.entries[1].versionId } }]);
    expect(axes(r).offline).toBe('needs-external');
  });
});

describe('signer binding (§5)', () => {
  test('T5-001: a broken chain is history invalid, with no state beyond the failure', async () => {
    const w = await World.create();
    const e2 = await w.entry((s) => { s.asset.name = 'Two'; });
    const broken = { ...e2, versionTime: '2027-01-01T00:00:00Z' };
    const r = await w.verify({ logs: [[w.entries[0], broken]] });
    expect(axes(r)).toMatchObject({ history: 'invalid', outcome: 'invalid', state: 'valid-as-of' });
    expect(r.checkpoint).toBe(w.entries[0].versionId);
    expect(labelOf(r, broken)).toEqual({ versionId: e2.versionId, status: 'rejected', rule: 'P14.29' });
  });

  test('T5-002, T5-003: a valid key of another identity, or not a method of the author DID, is rejected with identity failed', async () => {
    const w = await World.create();
    const mallory = await webvhSigner();
    const forged = await w.entry((s) => { s.asset.name = 'Mine'; }, { key: mallory.key });
    const r = await w.verify();
    expect(labelOf(r, forged)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
    expect(axes(r)).toMatchObject({ identity: 'failed', outcome: 'invalid' });
  });

  test('T5-006: an entry signed by a key the author DID added is accepted, with no asset log entry for the change', async () => {
    const w = await World.create();
    const k2 = seeded(201);
    await web(w.author).rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'key-2', signer: k2 }]);
    const e = await w.entry((s) => { s.asset.name = 'Two'; }, { ref: w.author.ref('key-2'), key: k2 });
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted', authority: 'current-key' });
    expect(axes(r).outcome).toBe('verified');
  });

  test('T5-007, T5-010: a key not under assertionMethod, or under authentication only, is identity failed', async () => {
    const w = await World.create();
    const k2 = seeded(202);
    await web(w.author).rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'auth', signer: k2, relationship: 'authentication' }]);
    const e = await w.entry((s) => { s.asset.name = 'Two'; }, { ref: w.author.ref('auth'), key: k2 });
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
    expect(axes(r).identity).toBe('failed');
  });

  test('T5-010: a verification method with another controller is identity failed', async () => {
    const w = await World.create();
    const k2 = seeded(203);
    await web(w.author).rotate([{ fragment: 'key-1', signer: w.author.key }, { fragment: 'key-2', signer: k2, controller: 'did:example:other' }]);
    const e = await w.entry((s) => { s.asset.name = 'Two'; }, { ref: w.author.ref('key-2'), key: k2 });
    expect(labelOf(await w.verify(), e)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
  });

  test('T5-008: an author key that is also an updateKey of the author DID is identity failed', async () => {
    const a = await WebvhAuthor.create([{ fragment: 'key-1', signer: seeded(91) }], { domain: 'upd.example.com' });
    const author: Signer = { did: a.did, key: seeded(91), kind: 'webvh', handle: a, log: () => serializeVh(a.entries), ref: (f = 'key-1', v = a.versionId) => a.ref(f, v) };
    const w = await World.create(author);
    const r = await w.verify();
    expect(labelOf(r, w.entries[0])).toMatchObject({ status: 'rejected', rule: 'P5.3' });
    expect(axes(r)).toMatchObject({ identity: 'failed', state: 'none' });
  });

  test('T5-011, T14-067: a key in another Multikey encoding (secp256k1 0xe701) is identity failed', async () => {
    const w = await World.create();
    const secp = localSigner('secp256k1', new Uint8Array(32).fill(7));
    await web(w.author).appendState({ ...web(w.author).document(w.author.did, [{ fragment: 'key-1', signer: w.author.key }]), verificationMethod: [{ id: `${w.author.did}#key-1`, type: 'Multikey', controller: w.author.did, publicKeyMultibase: w.author.key.publicKeyMultibase }, { id: `${w.author.did}#k`, type: 'Multikey', controller: w.author.did, publicKeyMultibase: secp.publicKeyMultibase }], assertionMethod: [`${w.author.did}#key-1`, `${w.author.did}#k`] });
    const e = await w.entry((s) => { s.asset.name = 'Two'; }, { ref: w.author.ref('k') });
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ status: 'rejected', rule: 'P14.8' });
    expect(axes(r).identity).toBe('failed');
  });

  test('T14-065: a small-order public key is identity failed', async () => {
    const w = await World.create();
    const small = encodeMultikey('Ed25519', new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    await web(w.author).appendState({ ...web(w.author).document(w.author.did, [{ fragment: 'key-1', signer: w.author.key }]), verificationMethod: [{ id: `${w.author.did}#key-1`, type: 'Multikey', controller: w.author.did, publicKeyMultibase: w.author.key.publicKeyMultibase }, { id: `${w.author.did}#z`, type: 'Multikey', controller: w.author.did, publicKeyMultibase: small }], assertionMethod: [`${w.author.did}#key-1`, `${w.author.did}#z`] });
    const e = await w.entry((s) => { s.asset.name = 'Two'; }, { ref: w.author.ref('z') });
    expect(labelOf(await w.verify(), e)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
  });

  test('T5-012: a later entry naming an older author DID version than an earlier entry is rejected', async () => {
    const w = await World.create();
    const v1 = w.author.ref().versionId;
    await web(w.author).rotate([{ fragment: 'key-1', signer: w.author.key }]);
    await w.entry((s) => { s.asset.name = 'Two'; });
    const back = await w.entry((s) => { s.asset.name = 'Three'; }, { ref: w.author.ref('key-1', v1) });
    expect(labelOf(await w.verify(), back)).toMatchObject({ status: 'rejected', rule: 'P5.8' });
  });

  test('T5-045: an author DID that changes DID method is not continuity', async () => {
    const w = await World.create();
    const vh = await vhSigner(w.author.key);
    const e = await w.entry((s) => { s.asset.name = 'Two'; s.author = vh.ref(); }, { ref: vh.ref() });
    expect(labelOf(await w.verify({ signers: [w.author, vh] }), e)).toMatchObject({ status: 'rejected', rule: 'P5.8' });
  });

  test('a DIF did:vh author is verified under its own method (P5.8, D10)', async () => {
    const w = await World.create(await vhSigner());
    await w.entry((s) => { s.asset.name = 'Two'; });
    expect(axes(await w.verify())).toMatchObject({ outcome: 'verified', identity: 'complete' });
  });

  test('T5-030: a did:vh log whose method value is not did:vh:1.0 is no evidence: identity incomplete, signer-history-missing (P5.8)', async () => {
    const w = await World.create(await vhSigner());
    const log = w.author.log().replaceAll('"did:vh:1.0"', '"did:vh:0.1"');
    const r = await w.verify({ histories: [{ did: w.author.did, log }] });
    expect(axes(r)).toMatchObject({ identity: 'incomplete', outcome: 'incomplete' });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', item: { kind: 'signer', id: w.author.did } }));
  });

  test('T5-061: a did:vh:1.0 log that breaks one of [S3]\'s rules (a fractional-second versionTime) is no evidence, not a valid prefix', async () => {
    const author = await vhSigner();
    const w = await World.create(author);
    const h = author.handle as unknown as { timeoutOverride?: string; timeOverride: string | null; rotate: (k: unknown[]) => Promise<string> };
    h.timeOverride = '2026-10-18T09:59:59.500Z';
    await h.rotate([{ fragment: 'key-1', signer: author.key }]);
    const r = await w.verify();
    expect(axes(r)).toMatchObject({ identity: 'incomplete', outcome: 'incomplete' });
    expect(r.diagnostics.map((d) => d.code)).toContain('signer-history-missing');
    expect(labelOf(r, w.entries[0])).toEqual({ versionId: w.entries[0].versionId, status: 'unchecked' });
  });

  test('T5-062: a did:vh:1.0 log written by the VH-Log-based pre-draft builder that verifies under [S3]\'s rules is that signer\'s log', async () => {
    // VhAuthor writes logs with the pre-draft's VH-Log builder (did:vh:1.0, whole seconds, id did:vh:<SCID>).
    const w = await World.create(await vhSigner());
    const r = await w.verify();
    expect(axes(r)).toMatchObject({ identity: 'complete', outcome: 'verified' });
    expect(r.signers[0].did).toMatch(/^did:vh:/);
  });

  test('T5-039, T5-042: a moved and rotated author signs naming a version after the move; a method controlled by the old DID fails', async () => {
    const w = await World.create();
    const k2 = seeded(204);
    const before = w.entries[0];
    await web(w.author).move('new.example.com', [{ fragment: 'key-2', signer: k2 }]);
    const e = await w.entry((s) => { s.asset.name = 'Moved'; }, { ref: w.author.ref('key-2'), key: k2 });
    const r = await w.verify();
    expect(labelOf(r, before)).toMatchObject({ status: 'accepted' });
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted', authority: 'current-key' });
    const wrongController = await World.create();
    const k3 = seeded(205);
    await web(wrongController.author).move('third.example.com', [{ fragment: 'key-3', signer: k3, controller: wrongController.author.did }]);
    const bad = await wrongController.entry((s) => { s.asset.name = 'x'; }, { ref: wrongController.author.ref('key-3'), key: k3 });
    expect(labelOf(await wrongController.verify(), bad)).toMatchObject({ status: 'rejected', rule: 'P5.3' });
  });

  test('T5-043: a log with another SCID listing the author in alsoKnownAs is not the author', async () => {
    const w = await World.create();
    const k = seeded(206);
    const impostor = await WebvhAuthor.create([{ fragment: 'key-1', signer: k }], { domain: 's-imp.example.com', alsoKnownAs: [w.author.did] });
    const r = await w.verify({ histories: [{ did: w.author.did, log: serializeVh(impostor.entries) }] });
    expect(axes(r).identity).not.toBe('complete');
  });

  test('T5-047: an editor entry naming an older editor DID version than its previous entry is rejected', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const old = ed.ref().versionId;
    await web(ed).rotate([{ fragment: 'key-1', signer: ed.key }]);
    await w.entry((s) => { s.asset.name = 'a'; }, { by: ed, editor: true });
    const back = await w.entry((s) => { s.asset.name = 'b'; }, { by: ed, editor: true, ref: ed.ref('key-1', old) });
    expect(labelOf(await w.verify({ signers: [w.author, ed] }), back)).toMatchObject({ status: 'rejected', rule: 'P5.8' });
  });

  test('T5-059: a secp256k1 method with a bip340-jcs-2025 proof is identity failed', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    const swapped = { ...e, proof: [{ ...(e.proof[0] as any), cryptosuite: 'bip340-jcs-2025' }] };
    const r = await w.verify({ logs: [[w.entries[0], swapped]] });
    expect(labelOf(r, swapped)).toMatchObject({ status: 'rejected', rule: 'P5.12' });
    expect(axes(r).identity).toBe('failed');
  });
});

describe('operations and forks (§6)', () => {
  async function fork() {
    const w = await World.create();
    const base = w.head;
    const a = await w.entry((s) => { s.asset.name = 'A'; }, { parent: base });
    const b = await w.entry((s) => { s.asset.name = 'B'; }, { parent: base, push: false });
    return { w, base, a, b };
  }

  test('T6-005, T6-015, T7-075: divergent valid branches are a conflict with no winner, whatever their lengths; the checkpoint is the fork point', async () => {
    const { w, base, a, b } = await fork();
    const a2 = await w.entry((s) => { s.asset.name = 'A2'; });
    const r = await w.verify({ logs: [[w.entries[0], a, a2], [w.entries[0], b]] });
    expect(axes(r).state).toBe('conflict');
    expect(r.checkpoint).toBe(base.versionId);
    for (const e of [a, a2, b]) expect(labelOf(r, e)).toMatchObject({ status: 'accepted' });
    expect(defaultCheck(r)).toBe(false);
  });

  test('T6-016: an entry bringing in content from another branch is accepted on its branch; the fork remains', async () => {
    const { w, a, b } = await fork();
    const merged = await w.entry((s) => { s.asset.metadata = { from: 'B' }; s.asset.name = 'B'; }, { parent: a });
    const r = await w.verify({ logs: [[w.entries[0], a, merged], [w.entries[0], b]] });
    expect(labelOf(r, merged)).toMatchObject({ status: 'accepted' });
    expect(axes(r).state).toBe('conflict');
  });

  test('T6-017: an evidence set holding a competing branch is a conflict, whatever an earlier report gave; no prior result is an input', async () => {
    const { w, a, b } = await fork();
    const earlier = await w.verify({ logs: [[w.entries[0], a]] });
    expect(axes(earlier).state).toBe('valid-as-of');
    const r = await w.verify({ logs: [[w.entries[0], a], [w.entries[0], b]] });
    expect(axes(r).state).toBe('conflict');
    expect(r).not.toHaveProperty('changes');
  });

  test('T6-018, T6-019: an author entry superseding an editor-only branch settles it; later editor entries on it are conflicting', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    const g = await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const edA = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true, parent: g, push: false });
    const edB = await w.entry((s) => { s.asset.name = 'by editor again'; }, { by: ed, editor: true, parent: edA, push: false });
    const sup = await w.entry((s) => { s.asset.name = 'by author'; s.supersedes = [edA.versionId]; }, { parent: g });
    const r = await w.verify({ logs: [w.entries, [w.entries[0], g, edA, edB]], signers: [w.author, ed] });
    expect(labelOf(r, edA)).toEqual({ versionId: edA.versionId, status: 'conflicting' });
    expect(labelOf(r, edB)).toEqual({ versionId: edB.versionId, status: 'conflicting' });
    expect(axes(r).state).toBe('valid-as-of');
    expect(r.checkpoint).toBe(sup.versionId);
  });

  test('T14-074: an author entry superseding 8 distinct editor-only branches is accepted and settles them all', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    const g = await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const branches = [];
    for (let i = 0; i < 8; i++) branches.push(await w.entry((s) => { s.asset.name = `editor ${i}`; }, { by: ed, editor: true, parent: g, push: false }));
    const sup = await w.entry((s) => { s.asset.name = 'by author'; s.supersedes = branches.map((b) => b.versionId); }, { parent: g });
    const r = await w.verify({ logs: [w.entries, ...branches.map((b) => [w.entries[0], g, b])], signers: [w.author, ed] });
    expect(labelOf(r, sup)).toMatchObject({ status: 'accepted' });
    for (const b of branches) expect(labelOf(r, b)).toEqual({ versionId: b.versionId, status: 'conflicting' });
    expect(axes(r).state).toBe('valid-as-of');
    expect(r.checkpoint).toBe(sup.versionId);
  });

  test('T6-020: supersedes naming a branch that holds an author entry settles nothing', async () => {
    const { w, a, b } = await fork();
    const sup = await w.entry((s) => { s.asset.name = 'A2'; s.supersedes = [b.versionId]; }, { parent: a });
    const r = await w.verify({ logs: [[w.entries[0], a, sup], [w.entries[0], b]] });
    expect(axes(r).state).toBe('conflict');
  });

  test('T6-021: supersedes naming an ancestor, or an entry whose parent is not an ancestor, is rejected', async () => {
    const { w, base, a } = await fork();
    const bad = await w.entry((s) => { s.supersedes = [base.versionId]; s.asset.name = 'x'; }, { parent: a });
    expect(labelOf(await w.verify({ logs: [[w.entries[0], a, bad]] }), bad)).toMatchObject({ status: 'rejected', rule: 'P6.9' });
  });

  test('T6-022: supersedes naming an entry not in the evidence set has no effect', async () => {
    const { w, a } = await fork();
    const sup = await w.entry((s) => { s.supersedes = ['2-QmV2yQcaZ5eeDyWKqeHW5whoWmhtH9ZygNfDcnFEqEt4vW']; s.asset.name = 'x'; }, { parent: a });
    const r = await w.verify({ logs: [[w.entries[0], a, sup]] });
    expect(labelOf(r, sup)).toMatchObject({ status: 'accepted' });
  });

  test('T6-024: a superseding author entry labelled key-removed-since and not endorsed settles nothing', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    const g = await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const edA = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true, parent: g, push: false });
    await w.entry((s) => { s.asset.name = 'by author'; s.supersedes = [edA.versionId]; }, { parent: g });
    await web(w.author).rotate([{ fragment: 'key-9', signer: seeded(209) }]);
    const r = await w.verify({ logs: [w.entries, [w.entries[0], g, edA]], signers: [w.author, ed] });
    expect(axes(r).state).toBe('conflict');
  });

  test('T6-025: a revoked editor forking again from before the superseded branch is a new conflict', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    const g = await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const edA = await w.entry((s) => { s.asset.name = 'e1'; }, { by: ed, editor: true, parent: g, push: false });
    await w.entry((s) => { s.asset.name = 'a'; s.supersedes = [edA.versionId]; delete s.asset.editors; }, { parent: g });
    const edC = await w.entry((s) => { s.asset.name = 'e2'; }, { by: ed, editor: true, parent: g, push: false });
    const r = await w.verify({ logs: [w.entries, [w.entries[0], g, edA], [w.entries[0], g, edC]], signers: [w.author, ed] });
    expect(axes(r).state).toBe('conflict');
  });

  test('T6-012: an entry a host changed fails verification', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    const changed = { ...e, state: { ...e.state, asset: { ...(e.state.asset as any), name: 'Host' } } };
    expect(labelOf(await w.verify({ logs: [[w.entries[0], changed]] }), changed)).toMatchObject({ status: 'rejected' });
  });
});

describe('evidence and the report (§7)', () => {
  test('T7-001, T7-058: a complete package of a never-anchored Original with a did:webvh author, no network: verified, self-contained', async () => {
    const w = await World.create();
    await w.entry((s) => w.version(s, res('v2')));
    const p = buildPackage({ original: w.did, assetLog: enc(serializeLog(w.entries)), versionIds: w.entries.map((e) => e.versionId), signers: [{ did: w.author.did, log: enc(w.author.log()) }], resources: Object.fromEntries(w.resources), missing: [] });
    const r = await verifyOriginal({ original: w.did, inputs: [{ kind: 'package', source: 'p.zip', bytes: p.archive }] });
    expect(axes(r)).toMatchObject({ outcome: 'verified', offline: 'self-contained', state: 'valid-as-of', availability: 'complete' });
    expect(r.signers?.[0]).toMatchObject({ source: 'package', freshness: 'not-established' });
  });

  test('T7-002, T7-054: missing historical bytes: availability partial; supplied bytes checked; default check passes', async () => {
    const w = await World.create();
    await w.entry((s) => w.version(s, res('v2')));
    const r = await w.verify({ resources: [res('v2')] });
    expect(axes(r).availability).toBe('partial');
    expect(r.diagnostics.map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'resource-missing', rule: 'P7.4', item: { kind: 'resource', id: resourceDigest(res('version 1')), versionId: w.entries[0].versionId } }]);
    expect(defaultCheck(r)).toBe(true);
    expect(axes(await w.verify({ resources: false })).availability).toBe('none');
  });

  test('T7-004, T7-017: an old valid prefix, or a fresh fetch, is valid-as-of its checkpoint, never current', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.name = 'Two'; });
    const r = await w.verify({ logs: [[w.entries[0]]] });
    expect(axes(r).state).toBe('valid-as-of');
    expect(r.checkpoint).toBe(w.entries[0].versionId);
    expect(r.signers?.[0]).toMatchObject({ latestVersionId: w.author.ref().versionId, obtained: '2026-11-20T00:00:00Z' });
  });

  test('T7-005, T7-050: an unanchored entry signed by a removed key is key-removed-since; authority historical; history valid', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    await web(w.author).rotate([{ fragment: 'key-2', signer: seeded(210) }]);
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ status: 'accepted', authority: 'key-removed-since', endorsed: false, ordering: 'claimed' });
    expect(axes(r)).toMatchObject({ authority: 'historical', history: 'valid' });
    expect(defaultCheck(r)).toBe(false);
  });

  test('T7-049: a later author entry with the new key endorses entries signed with the removed key', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    const k2 = seeded(211);
    await web(w.author).rotate([{ fragment: 'key-2', signer: k2 }]);
    await w.entry((s) => { s.asset.name = 'Three'; }, { ref: w.author.ref('key-2'), key: k2 });
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ authority: 'key-removed-since', endorsed: true });
    expect(axes(r).authority).toBe('current');
    expect(defaultCheck(r)).toBe(true);
  });

  test('T7-007: entries after the author DID is deactivated are did-deactivated-since and fail the default check', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    await web(w.author).appendState(w.author.handle.entries[w.author.handle.entries.length - 1].state, { deactivated: true });
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ authority: 'did-deactivated-since' });
    expect(defaultCheck(r)).toBe(false);
  });

  test('T7-008, T7-046: a newer signer version in the evidence set wins over an older one, and is named', async () => {
    const w = await World.create();
    const old = w.author.log();
    await web(w.author).rotate([{ fragment: 'key-2', signer: seeded(212) }]);
    const withNewer = await w.verify({ histories: [{ did: w.author.did, log: old, source: 'host' }, { did: w.author.did, log: w.author.log(), source: 'retained' }] });
    const withoutNewer = await w.verify({ histories: [{ did: w.author.did, log: old, source: 'host' }] });
    expect(withNewer.signers?.[0]).toMatchObject({ source: 'retained', latestVersionId: w.author.ref().versionId });
    expect(labelOf(withNewer, w.entries[0])).toMatchObject({ authority: 'key-removed-since' });
    expect(labelOf(withoutNewer, w.entries[0])).toMatchObject({ authority: 'current-key' });
    expect(withNewer.evidence.inputs).not.toEqual(withoutNewer.evidence.inputs);
  });

  test('T7-010, T14-072: a signer history of 1,001 versions is limit-exceeded and never complete', async () => {
    const w = await World.create();
    for (let i = 0; i < 1000; i++) await web(w.author).rotate([{ fragment: 'key-1', signer: w.author.key }]);
    const r = await w.verify();
    expect(axes(r).history).toBe('limit-exceeded');
    expect(defaultCheck(r)).toBe(false);
  }, 120_000);

  test('T7-014, T7-051: an editor entry signed with a key removed from the editor DID is key-removed-since; an author entry endorses it', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const e = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    await web(ed).rotate([{ fragment: 'key-2', signer: seeded(213) }]);
    const r = await w.verify({ signers: [w.author, ed] });
    expect(labelOf(r, e)).toMatchObject({ authority: 'key-removed-since', endorsed: false });
    expect(defaultCheck(r)).toBe(false);
    await w.entry((s) => { s.asset.metadata = { ok: true }; });
    const r2 = await w.verify({ signers: [w.author, ed] });
    expect(labelOf(r2, e)).toMatchObject({ authority: 'key-removed-since', endorsed: true });
    expect(defaultCheck(r2)).toBe(true);
  });

  test('T7-015: an editor entry after the author DID is deactivated is did-deactivated-since', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const e = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    await web(w.author).appendState(w.author.handle.entries[w.author.handle.entries.length - 1].state, { deactivated: true });
    expect(labelOf(await w.verify({ signers: [w.author, ed] }), e)).toMatchObject({ authority: 'did-deactivated-since' });
  });

  test('T7-065: an editor entry whose editor DID was then deactivated is did-deactivated-since, endorsed by a later current-key author entry; the default check passes', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const e = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    await web(ed).appendState(ed.handle.entries[ed.handle.entries.length - 1].state, { deactivated: true });
    const before = await w.verify({ signers: [w.author, ed] });
    expect(labelOf(before, e)).toMatchObject({ authority: 'did-deactivated-since', endorsed: false });
    expect(axes(before).authority).toBe('historical');
    expect(defaultCheck(before)).toBe(false);
    await w.entry((s) => { s.asset.metadata = { reviewed: true }; delete s.asset.editors; });
    const after = await w.verify({ signers: [w.author, ed] });
    expect(labelOf(after, e)).toMatchObject({ authority: 'did-deactivated-since', endorsed: true });
    expect(axes(after).authority).toBe('current');
    expect(defaultCheck(after)).toBe(true);
  });

  test('T7-066: with the author DID deactivated after the editor entry, nothing endorses it and the default check fails', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const e = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    const later = await w.entry((s) => { s.asset.metadata = { reviewed: true }; });
    await web(w.author).appendState(w.author.handle.entries[w.author.handle.entries.length - 1].state, { deactivated: true });
    const r = await w.verify({ signers: [w.author, ed] });
    expect(labelOf(r, e)).toMatchObject({ authority: 'did-deactivated-since', endorsed: false });
    expect(labelOf(r, later)).toMatchObject({ authority: 'did-deactivated-since' });
    expect(axes(r).authority).toBe('historical');
    expect(defaultCheck(r)).toBe(false);
  });

  test('T7-016, T7-047: a missing editor DID history leaves its entry unchecked, identity incomplete; nothing is fetched', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    const e = await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    const r = await w.verify();
    expect(labelOf(r, e)).toEqual({ versionId: e.versionId, status: 'unchecked' });
    expect(axes(r)).toMatchObject({ identity: 'incomplete', outcome: 'incomplete', offline: 'needs-external' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['signer-history-missing', 'proof-unchecked']);
    expect(r.diagnostics[0].item).toEqual({ kind: 'signer', id: ed.did });
    expect(r.diagnostics[1].item).toEqual({ kind: 'entry', id: e.versionId });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('T7-018: a log obtained from a location without witnesses has freshness not-established, with where and when', async () => {
    const w = await World.create();
    const r = await w.verify({ histories: [{ did: w.author.did, log: w.author.log(), source: 'https://s.example.com/did.jsonl', obtained: '2026-11-21T08:00:00Z' }] });
    expect(r.signers?.[0]).toMatchObject({ source: 'https://s.example.com/did.jsonl', obtained: '2026-11-21T08:00:00Z', freshness: 'not-established' });
  });

  test('T7-020: a log whose latest version moves the DID and removes a key: the removal is applied; freshness not established', async () => {
    const w = await World.create();
    const e = await w.entry((s) => { s.asset.name = 'Two'; });
    await web(w.author).move('moved.example.com', [{ fragment: 'key-2', signer: seeded(214) }]);
    const r = await w.verify();
    expect(labelOf(r, e)).toMatchObject({ authority: 'key-removed-since' });
    expect(r.signers?.[0].freshness).toBe('not-established');
  });

  test('T7-039, T7-060: a complete package of an anchored Original read without the anchor: historical-checkpoint, bitcoin missing-evidence', async () => {
    const w = await World.create();
    const before = await w.entry((s) => { s.asset.name = 'Two'; });
    const anchor = await w.entry((s) => { s.asset.aliases = ['did:btco:reg:42']; s.asset.body = 'none'; });
    const p = buildPackage({ original: w.did, assetLog: enc(serializeLog(w.entries)), versionIds: w.entries.map((e) => e.versionId), signers: [{ did: w.author.did, log: enc(w.author.log()) }], resources: Object.fromEntries(w.resources), missing: [] });
    const r = await verifyOriginal({ original: w.did, inputs: [{ kind: 'package', source: 'p.zip', bytes: p.archive }] });
    expect(axes(r)).toMatchObject({ state: 'historical-checkpoint', bitcoin: 'missing-evidence', outcome: 'incomplete', offline: 'needs-external' });
    expect(r.checkpoint).toBe(before.versionId);
    expect(labelOf(r, anchor)).toEqual({ versionId: anchor.versionId, status: 'unchecked' });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'anchoring-sat-not-read', item: { kind: 'sat', id: 'did:btco:reg:42' } }));
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'proof-unchecked', item: { kind: 'entry', id: anchor.versionId } }));
  });

  test('T7-040, T7-059: a package with a did:btco author is not self-contained and lists the author\'s sat', async () => {
    const btco = { did: 'did:btco:reg:777', verificationMethod: 'did:btco:reg:777#key-1', versionId: 'aai0' };
    const w = await World.create();
    const state = { ...w.entries[0].state, author: btco };
    const { prepareGenesis, signEntry } = await import('../src/og/index.js');
    const g = await signEntry(prepareGenesis({ versionTime: '2026-11-01T00:00:00Z', state: { ...state, id: 'did:og:{SCID}' } }), btco.verificationMethod, w.author.key);
    const r = await verifyOriginal({ original: g.state.id as string, inputs: [{ kind: 'log', source: 'l', bytes: enc(serializeLog([g])) }, { kind: 'resource', source: 'r', bytes: res('version 1') }] });
    expect(axes(r)).toMatchObject({ identity: 'incomplete', offline: 'needs-external' });
    expect(r.diagnostics.filter((d) => d.code === 'signer-sat-not-read').map((d) => d.item)).toEqual([{ kind: 'sat', id: 'did:btco:reg:777' }]);
  });

  test('T7-069 (off chain) and T14-095: diagnostics differing only in reason are the same report', async () => {
    const w = await World.create();
    const r = await w.verify({ resources: false });
    const other = { ...r, diagnostics: r.diagnostics.map((d) => ({ ...d, reason: 'other words' })) };
    expect(sameReport(r, other)).toBe(true);
    expect(sameReport(r, { ...r, diagnostics: [] })).toBe(false);
  });

  test('T14-094: one diagnostic per code and item, in the code order of P14.25, then item id; no missing or dependencies members', async () => {
    const w = await World.create();
    const ed = await webvhSigner();
    await w.entry((s) => { s.asset.editors = [grant(ed.did, { name: true })]; });
    await w.entry((s) => w.version(s, res('v2')));
    await w.entry((s) => { s.asset.name = 'by editor'; }, { by: ed, editor: true });
    await w.entry((s) => { s.asset.name = 'by editor again'; }, { by: ed, editor: true });
    const r = await w.verify({ resources: false });
    expect(r).not.toHaveProperty('missing');
    expect(r).not.toHaveProperty('dependencies');
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(['resource-missing', 'resource-missing', 'signer-history-missing', 'proof-unchecked', 'proof-unchecked']);
    const ids = r.diagnostics.filter((d) => d.code === 'resource-missing').map((d) => d.item.id);
    expect(ids).toEqual([...ids].sort());
    expect(r.diagnostics.filter((d) => d.code === 'signer-history-missing')).toHaveLength(1);
  });

  test('T14-096: an input whose bytes do not match its stated digest is unusable and not used', async () => {
    const w = await World.create();
    const e = w.evidence();
    const res0 = e.inputs.find((i) => i.kind === 'resource')!;
    res0.digest = resourceDigest(res('something else'));
    const r = await verifyOriginal(e);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['resource-missing', 'input-unusable']);
    expect(r.diagnostics[1].item).toEqual({ kind: 'input', id: res0.source });
    expect(axes(r)).toMatchObject({ availability: 'none', offline: 'needs-external', outcome: 'verified' });
  });

  test('T7-048: every axis present, each from its list', async () => {
    const r = await (await World.create()).verify();
    expect(checkAxes(r.axes as never)).toEqual([]);
    expect(checkAxes({ ...(r.axes as object), state: 'fresh' })).toHaveLength(1);
    const { state: _s, ...missingState } = r.axes as Record<string, string>;
    expect(checkAxes(missingState)).toHaveLength(1);
  });

  test('T14-085: a log under originals:1.0 is unsupported, with no state', async () => {
    const w = await World.create();
    const old = serializeLog(w.entries).replace('"og:1.0-draft.1"', '"originals:1.0"');
    const r = await verifyOriginal({ original: w.did, inputs: [{ kind: 'log', source: 'old.jsonl', bytes: enc(old) }] });
    expect(r).toMatchObject({ original: null, checkpoint: null, axes: { outcome: 'unsupported' }, entries: [], signers: [], diagnostics: [] });
    expect(r).not.toHaveProperty('changes');
  });
});

export type { EvidenceSet, Report };
