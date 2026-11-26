/**
 * A did:webvh alias for an existing did:og Original, from logs signed elsewhere (P3.6, P14.29): the
 * SDK reads the bundle, prepares the exact entry the existing author key signs, and checks the signed
 * entry with the alias's own log. Keys here are throwaway, made in memory, and never written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSigner, type ProofSigner } from '@originals/vh/crypto';
import { createLog, serializeLog as serializeVh, signWith } from '@originals/vh/log';
import { buildPackage, prepareGenesis, prepareNext, resourceDigest, serializeLog, signEntry, stateOf, writePackageZip, type OgEntry } from '@originals/vh/og';
import { aliasSigningRequest, bundleEvidence, checkBundleAlias, inspectBundle } from '../../../src/og/alias.js';
import { aliasCommand } from '../../../src/og/cli.js';

const enc = (s: string) => new TextEncoder().encode(s);
const key = (): ProofSigner => localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
const CTX = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];
const at = (m: number) => `2026-11-20T12:${String(m).padStart(2, '0')}:00Z`;

async function webvh(host: string, path: string, aka?: string[]) {
  const update = key(), assertion = key(), id = `did:webvh:{SCID}:${host}:${path}`;
  const k = update.publicKeyMultibase;
  const g = await createLog({
    versionTime: at(0), parameters: { method: 'did:webvh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: { '@context': CTX, id, ...(aka ? { alsoKnownAs: aka } : {}), verificationMethod: [{ id: `${id}#key-1`, type: 'Multikey', controller: id, publicKeyMultibase: assertion.publicKeyMultibase }], assertionMethod: [`${id}#key-1`] },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  const did = g.state.id as string;
  return { did, vm: `${did}#key-1`, versionId: g.versionId, assertion, log: serializeVh([g]) };
}

/** A six-cut video Original as a did:og bundle, the shape of the bundles `originals-og` and the landing carry. */
async function sixCut(opts: { anchored?: boolean } = {}) {
  const author = await webvh('example.com', 'film');
  const ref = { did: author.did, verificationMethod: author.vm, versionId: author.versionId };
  const cuts = Array.from({ length: 6 }, (_, i) => enc(`cut ${i + 1} ${'#'.repeat(40 * (i + 1))}`));
  const d = (b: Uint8Array) => ({ digest: resourceDigest(b), mediaType: 'video/mp4', size: b.length });
  const asset = (i: number) => ({ aliases: [] as string[], metadata: { cut: String(i + 1) }, name: 'Six cuts', network: 'mainnet', resource: d(cuts[i]), status: 'active' });
  const entries: OgEntry[] = [await signEntry(prepareGenesis({ versionTime: at(1), state: { asset: asset(0), author: ref, id: 'did:og:{SCID}', operation: 'create', transitions: [{ from: null, to: d(cuts[0]).digest }] } }), author.vm, author.assertion)];
  const original = stateOf(entries[0]).id;
  for (let i = 1; i < 6; i++) entries.push(await signEntry(prepareNext(entries[i - 1], { versionTime: at(1 + i), parameters: {}, state: { asset: asset(i), author: ref, id: original, operation: 'update', transitions: [{ from: d(cuts[i - 1]).digest, to: d(cuts[i]).digest }] } }), author.vm, author.assertion));
  if (opts.anchored) {
    const s = stateOf(entries[5]);
    entries.push(await signEntry(prepareNext(entries[5], { versionTime: at(10), parameters: {}, state: { ...s, operation: 'update', transitions: [], asset: { ...s.asset, aliases: ['did:btco:1234'], body: 'none' } } as never }), author.vm, author.assertion));
  }
  const archive = buildPackage({
    original, assetLog: enc(serializeLog(entries)), versionIds: entries.map((e) => e.versionId),
    signers: [{ did: author.did, log: enc(author.log) }], resources: Object.fromEntries(cuts.map((b) => [resourceDigest(b), b])), missing: [],
  }).archive;
  return { author, original, entries, archive };
}

const dir = mkdtempSync(join(tmpdir(), 'og-alias-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, data: string | Uint8Array) => { const p = join(dir, name); writeFileSync(p, data); return p; };
const run = async (step: string, flags: Record<string, string | true>) => {
  const lines: string[] = [];
  const code = await aliasCommand(step, new Map(Object.entries(flags)), (l) => lines.push(l));
  return { code, out: lines.join('\n') };
};

describe('the SDK alias workflow', () => {
  test('bundle → signing request → signed elsewhere → verified, with the ID, author and media unchanged; nothing hosted', async () => {
    const b = await sixCut();
    const evidence = bundleEvidence(b.archive, 'six-cut.zip');
    expect(evidence.original).toBe(b.original);
    const inspected = await inspectBundle(evidence);
    expect(inspected).toMatchObject({ checkpoint: b.entries[5].versionId, author: b.author.did, aliases: [] });
    expect(inspected.report?.axes.outcome).toBe('verified');

    const alias = await webvh('alias.example.com', 'six-cuts', [b.original]);
    const req = await aliasSigningRequest(evidence, alias.did, () => new Date(at(30)));
    expect(req).toMatchObject({ original: b.original, checkpoint: b.entries[5].versionId, author: b.author.did, verificationMethod: b.author.vm });
    // Signed where the key lives; the SDK never sees it.
    const signed = await signEntry(req.unsigned, req.verificationMethod, b.author.assertion);
    const r = await checkBundleAlias({ evidence, entry: serializeLog([signed]), aliasLog: alias.log });
    expect(r.reasons).toEqual([]);
    expect(r).toMatchObject({ status: 'verified', hosted: false, original: b.original, author: b.author.did, alias: alias.did, checkpointBefore: b.entries[5].versionId });
    expect(r.checkpointAfter).toStartWith('7-');
    expect(r.resource).toEqual(stateOf(b.entries[5]).asset.resource);
  });

  test('a bundle that is not did:og, or a ZIP that is not a package, is refused with its reason', () => {
    expect(() => bundleEvidence(enc('not a zip'))).toThrow();
    expect(() => bundleEvidence(writePackageZip({ 'readme.txt': enc('hi') }))).toThrow(/not a did:og bundle/);
  });

  test('P9.10: an anchored Original gets no signing request for a new did:webvh alias', async () => {
    const b = await sixCut({ anchored: true });
    const alias = await webvh('alias.example.com', 'six-cuts', [b.original]);
    await expect(aliasSigningRequest(bundleEvidence(b.archive), alias.did)).rejects.toThrow(/P9\.10/);
  });
});

describe('originals-og alias', () => {
  test('inspect, unsigned and verify: exit 0 only when verified; a wrong signer, a stale entry and a missing backlink exit 1', async () => {
    const b = await sixCut();
    const bundle = file('six-cut.zip', b.archive);
    const inspected = await run('inspect', { bundle });
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.out)).toMatchObject({ original: b.original, checkpoint: b.entries[5].versionId });

    const alias = await webvh('alias.example.com', 'six-cuts', [b.original]);
    const unsigned = await run('unsigned', { bundle, alias: alias.did, time: at(30) });
    expect(unsigned.code).toBe(0);
    const good = await signEntry(JSON.parse(unsigned.out), b.author.vm, b.author.assertion);
    const aliasLog = file('did.jsonl', alias.log);

    const ok = await run('verify', { bundle, entry: file('next.jsonl', serializeLog([good])), 'alias-log': aliasLog });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('Not hosted');

    const wrong = await signEntry(JSON.parse(unsigned.out), b.author.vm, key());
    expect((await run('verify', { bundle, entry: file('wrong.jsonl', serializeLog([wrong])), 'alias-log': aliasLog })).code).toBe(1);

    const s = stateOf(b.entries[4]);
    const stale = await signEntry(prepareNext(b.entries[4], { versionTime: at(30), parameters: {}, state: { ...s, operation: 'update', transitions: [], asset: { ...s.asset, aliases: [alias.did] } } as never }), b.author.vm, b.author.assertion);
    const staleRun = await run('verify', { bundle, entry: file('stale.jsonl', serializeLog([stale])), 'alias-log': aliasLog, json: true });
    expect(staleRun.code).toBe(1);
    expect(JSON.parse(staleRun.out).checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id)).toEqual(['extends-checkpoint']);

    const noBack = await webvh('alias.example.com', 'six-cuts');
    const req = await aliasSigningRequest(bundleEvidence(b.archive), noBack.did, () => new Date(at(31)));
    const e = await signEntry(req.unsigned, req.verificationMethod, b.author.assertion);
    expect((await run('verify', { bundle, entry: file('nb.jsonl', serializeLog([e])), 'alias-log': file('nb-did.jsonl', noBack.log) })).code).toBe(1);
  });
});
