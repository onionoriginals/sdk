// Adding a did:webvh alias to an existing did:og from logs signed elsewhere (P3.6, P14.29, P5.3, P5.8, P9.10).
import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner, type ProofSigner } from '../src/crypto/index.js';
import { createLog, serializeLog as serializeVh, signWith } from '../src/log/index.js';
import {
  aliasCheckpoint, buildPackage, checkAliasUpdate, prepareAliasEntry, prepareGenesis, resourceDigest, serializeLog, signEntry,
  stateOf, type AliasUpdateReport, type EvidenceSet, type OgEntry,
} from '../src/og/index.js';
import { enc, res, webvhSigner, World } from './helpers/og-world.js';
import { anchoring, Chain } from './helpers/og-chain.js';

let n = 0;
const key = (): ProofSigner => localSigner('Ed25519', sha256(enc(`alias-update key ${n++}`)));

/** A did:webvh alias log with its own update key, its document listing `aka` in alsoKnownAs. */
async function aliasLog(aka: string[] | undefined, opts: { path?: string; update?: ProofSigner } = {}) {
  const update = opts.update ?? key();
  const id = `did:webvh:{SCID}:alias.example.com:${opts.path ?? 'film'}`;
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: '2026-11-01T00:30:00Z',
    parameters: { method: 'did:webvh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id, ...(aka ? { alsoKnownAs: aka } : {}),
      verificationMethod: [{ id: `${id}#key-1`, type: 'Multikey', controller: id, publicKeyMultibase: key().publicKeyMultibase }], assertionMethod: [`${id}#key-1`],
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeVh([genesis]) };
}

/** A three-version Original. */
async function world(): Promise<World> {
  const w = await World.create();
  await w.entry((s) => w.version(s, res('version 2')));
  await w.entry((s) => w.version(s, res('version 3')));
  return w;
}

const line = (e: OgEntry) => serializeLog([e]);
const failed = (r: AliasUpdateReport) => r.checks.filter((c) => !c.ok).map((c) => c.id);

/** The alias entry, signed by the author's key unless told otherwise. */
async function aliasEntry(w: World, alias: string, opts: { parent?: OgEntry; signer?: ProofSigner; change?: (s: any) => void } = {}) {
  return w.entry((s) => { s.asset.aliases = [...s.asset.aliases, alias]; opts.change?.(s); }, { parent: opts.parent, key: opts.signer, push: false });
}

/** The evidence as a did:og package (P14.10), as `originals-og` and the landing's bundles carry it. */
function asPackage(w: World): EvidenceSet {
  const pkg = buildPackage({
    original: w.did, assetLog: enc(serializeLog(w.entries)), versionIds: w.entries.map((e) => e.versionId),
    signers: [{ did: w.author.did, log: enc(w.author.log()) }], resources: Object.fromEntries(w.resources), missing: [],
  });
  return { original: w.did, checkpoint: null, inputs: [{ kind: 'package', source: 'package:test.zip', bytes: pkg.archive }] };
}

describe('checkAliasUpdate', () => {
  test('P3.6, P14.29: an alias-only entry by the author and a separately signed alias log that points back verify; nothing is hosted', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    for (const evidence of [w.evidence(), asPackage(w)]) {
      const r = await checkAliasUpdate({ evidence, entry: line(await aliasEntry(w, al.did)), aliasLog: al.log });
      expect(failed(r)).toEqual([]);
      expect(r).toMatchObject({ status: 'verified', hosted: false, original: w.did, author: w.author.did, alias: al.did, aliasHost: 'alias.example.com/film', checkpointBefore: w.head.versionId });
      expect(r.checkpointAfter).toStartWith('4-');
      expect(r.resource).toEqual(stateOf(w.head).asset.resource);
      expect(r.checks.map((c) => c.id)).toEqual(['imported', 'entry', 'extends-checkpoint', 'alias-only', 'signed-by-author', 'media-unchanged', 'alias-log', 'backlink', 'links-agree', 'separate-signer']);
      expect(r.report?.checkpoint).toBe(r.checkpointAfter);
    }
  });

  test('prepareAliasEntry gives the exact entry to sign, and the signed result verifies', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const cp = await aliasCheckpoint(asPackage(w));
    expect(cp.problem).toBeNull();
    expect(cp.entry!.versionId).toBe(w.head.versionId);
    const unsigned = prepareAliasEntry(cp.entry!, al.did, '2026-11-01T01:00:00Z');
    expect(stateOf({ ...unsigned, proof: [] } as OgEntry).transitions).toEqual([]);
    const signed = await signEntry(unsigned, w.author.ref().verificationMethod, w.author.key);
    expect((await checkAliasUpdate({ evidence: asPackage(w), entry: line(signed), aliasLog: al.log })).status).toBe('verified');
    expect(() => prepareAliasEntry(cp.entry!, 'did:web:example.com', '2026-11-01T01:00:00Z')).toThrow();
  });

  test('P5.3: an entry signed by any other key is rejected', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const other = await webvhSigner();
    for (const signer of [key(), other.key]) {
      const r = await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, al.did, { signer })), aliasLog: al.log });
      expect(r.status).toBe('rejected');
      expect(failed(r)).toEqual(['signed-by-author']);
      expect(r.reasons[0]).toContain('P5.3');
    }
  });

  test('P14.29: an entry on a stale checkpoint, a new genesis, or a whole log is rejected', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const stale = await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, al.did, { parent: w.entries[1] })), aliasLog: al.log });
    expect(failed(stale)).toEqual(['extends-checkpoint']);
    expect(stale.reasons[0]).toContain(w.head.versionId);
    const genesis = await signEntry(prepareGenesis({ versionTime: '2026-11-01T01:00:00Z', state: { ...(w.entries[0].state as object), id: 'did:og:{SCID}' } as never }), w.author.ref().verificationMethod, w.author.key);
    expect(failed(await checkAliasUpdate({ evidence: w.evidence(), entry: line(genesis), aliasLog: al.log }))).toEqual(['extends-checkpoint']);
    expect(failed(await checkAliasUpdate({ evidence: w.evidence(), entry: serializeLog(w.entries), aliasLog: al.log }))).toEqual(['entry']);
  });

  test('P3.6: a missing backlink, a backlink to another Original, a different alias, or a tampered alias log is rejected', async () => {
    const w = await world();
    const other = await World.create();
    const none = await aliasLog(undefined);
    const elsewhere = await aliasLog([other.did]);
    const right = await aliasLog([w.did]);
    const another = await aliasLog([w.did], { path: 'other-film' });
    expect(failed(await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, none.did)), aliasLog: none.log }))).toEqual(['backlink', 'links-agree']);
    expect(failed(await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, elsewhere.did)), aliasLog: elsewhere.log }))).toEqual(['backlink', 'links-agree']);
    const mismatch = await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, right.did)), aliasLog: another.log });
    expect(failed(mismatch)).toEqual(['links-agree']);
    expect(mismatch.reasons[0]).toContain(another.did);
    const tampered = right.log.replace(w.did, other.did);
    expect(failed(await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, right.did)), aliasLog: tampered }))).toEqual(['alias-log', 'links-agree']);
  });

  test('P4.3: tampered media bytes are rejected, in a package or as a resource input', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const entry = line(await aliasEntry(w, al.did));
    const head = stateOf(w.head).asset.resource.digest;
    const loose = w.evidence();
    for (const i of loose.inputs) if (i.kind === 'resource' && resourceDigest(i.bytes) === head) i.digest = head, i.bytes = res('tampered');
    const r1 = await checkAliasUpdate({ evidence: loose, entry, aliasLog: al.log });
    expect(r1.status).toBe('rejected');
    expect(failed(r1)).toEqual(['media-unchanged']);

    const tw = await world();
    tw.resources.set(stateOf(tw.head).asset.resource.digest, res('tampered'));
    const al2 = await aliasLog([tw.did]);
    const r2 = await checkAliasUpdate({ evidence: asPackage(tw), entry: line(await aliasEntry(tw, al2.did)), aliasLog: al2.log });
    expect(r2.status).toBe('rejected');
    expect(failed(r2)).toContain('media-unchanged');
  });

  test('alias-only (policy): an entry that also changes the media, the author or the name is rejected', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const someone = await webvhSigner();
    const cases: Array<(s: any) => void> = [
      (s) => w.version(s, res('version 4')),
      (s) => { s.author = someone.ref(); },
      (s) => { s.asset.name = 'Renamed'; },
    ];
    for (const change of cases) {
      const r = await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, al.did, { change })), aliasLog: al.log });
      expect(r.status).toBe('rejected');
      expect(failed(r)).toContain('alias-only');
    }
  });

  test('separate-signer (policy): an alias log controlled by the author identity\'s update key is rejected unless the caller opts out', async () => {
    const w = await world();
    // The test helpers' did:webvh authors share one update key (seeded 91), so an alias built the same way shares it.
    const authorUpdate = (w.author.handle as { update: ProofSigner }).update;
    const al = await aliasLog([w.did], { update: authorUpdate });
    const input = { evidence: w.evidence(), entry: line(await aliasEntry(w, al.did)), aliasLog: al.log };
    expect(failed(await checkAliasUpdate(input))).toEqual(['separate-signer']);
    expect((await checkAliasUpdate(input, { requireSeparateSigner: false })).status).toBe('verified');
  });

  test('P9.10: an anchored Original cannot take a new did:webvh alias, with or without its Bitcoin read', async () => {
    const w = await World.create();
    await w.entry((s) => { s.asset.aliases = ['did:btco:reg:5000']; s.asset.body = 'none'; });
    const chain = new Chain();
    chain.publish('did:btco:reg:5000', anchoring(w));
    const evidence = chain.evidence(w.did);
    const al = await aliasLog([w.did]);
    const r = await checkAliasUpdate({ evidence, entry: line(await aliasEntry(w, al.did)), aliasLog: al.log });
    expect(r.status).toBe('rejected');
    expect(failed(r)).toEqual(['imported']);
    expect(r.reasons[0]).toContain('P9.10');
    // The same package without its Bitcoin read verifies only to the entry before anchoring (P7.14): still refused, never forked.
    const offChain = await checkAliasUpdate({ evidence: w.evidence(), entry: line(await aliasEntry(w, al.did, { parent: w.entries[0] })), aliasLog: al.log });
    expect(failed(offChain)).toEqual(['imported']);
  });

  test('a history with an unaccepted entry, or a fork, has no exact checkpoint to extend', async () => {
    const w = await world();
    const al = await aliasLog([w.did]);
    const forkA = await w.entry((s) => { s.asset.name = 'A'; }, { push: false });
    const forkB = await w.entry((s) => { s.asset.name = 'B'; }, { push: false });
    const forked = w.evidence({ logs: [[...w.entries, forkA], [...w.entries, forkB]] });
    const r = await checkAliasUpdate({ evidence: forked, entry: line(await aliasEntry(w, al.did)), aliasLog: al.log });
    expect(failed(r)).toEqual(['imported']);
  });
});
