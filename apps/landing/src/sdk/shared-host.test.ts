/**
 * Shared-host saves through the landing's real routes and durable store
 * (P6.6, P6.7, P6.8; section 12 rows 131-137 of spec a432aa67). Two devices of
 * one author save the same Original; the second is signed in as a different
 * account, which the host accepts because the signed entry, not the account,
 * authorizes the change.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { localSigner, multibaseEncode, proofHashData } from '@originals/vh/crypto';
import { parseJson } from '@originals/vh/json';
import { appendEntry, createLog, serializeLog, signWith, type LogEntry } from '@originals/vh/log';
import { resourceDigest, verifyOriginal, type AuthorDidEvidence, type AuthorRef } from '@originals/vh/originals';
import { MemoryStore, OriginalsSDK, keySigner, writeEvidence, type OriginalsSigner, type Submission } from '@originals/sdk/originals';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { publishOriginal } from './publish';
import { DOMAIN, SUB, cookieFor, host } from './publish.fixture';
import { encodeSubmission, landingSharedHost, siteKeyOf } from './shared-host';

const START = Date.now();
const LATER = START + 3_600_000;
const SUB2 = 'sub-collaborator-02';
const enc = (s: string) => new TextEncoder().encode(s);
const SVG = enc('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
const THEIRS = enc('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
const MINE = enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="6"/></svg>');
const NOON = enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9"/></svg>');

/** An author DID with two assertionMethod keys, so one branch can carry more signing keys than another. */
async function twoKeyAuthor(now: Date) {
  const update = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
  const secrets = [crypto.getRandomValues(new Uint8Array(32)), crypto.getRandomValues(new Uint8Array(32))];
  const did = 'did:vh:{SCID}';
  const genesis = await createLog({
    versionTime: new Date(Math.floor(now.getTime() / 1000) * 1000 - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [update.publicKeyMultibase] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: did,
      verificationMethod: secrets.map((s, i) => ({ id: `${did}#author-${i}`, type: 'Multikey', controller: did, publicKeyMultibase: localSigner('Ed25519', s).publicKeyMultibase })),
      assertionMethod: secrets.map((_, i) => `${did}#author-${i}`),
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` }),
  });
  const authorDid = genesis.state.id as string;
  const key = (i: number): { ref: AuthorRef; signer: OriginalsSigner } => ({
    ref: { did: authorDid, verificationMethod: `${authorDid}#author-${i}`, versionId: genesis.versionId },
    signer: keySigner({ keyType: 'Ed25519', secretKey: secrets[i], verificationMethod: `${authorDid}#author-${i}` }),
  });
  const evidence: AuthorDidEvidence = { did: authorDid, log: serializeLog([genesis]) };
  /** v2 of the author DID: key 0 removed, or the DID deactivated. */
  async function rotate(at: Date, opts: { deactivate?: boolean } = {}): Promise<AuthorDidEvidence> {
    const v2 = await appendEntry(genesis, {
      versionTime: new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      parameters: opts.deactivate ? { deactivated: true, updateKeys: [] } : {},
      state: {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
        id: authorDid,
        verificationMethod: [{ id: `${authorDid}#author-1`, type: 'Multikey', controller: authorDid, publicKeyMultibase: localSigner('Ed25519', secrets[1]).publicKeyMultibase }],
        assertionMethod: [`${authorDid}#author-1`],
      },
      sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` }),
    });
    return { did: authorDid, log: serializeLog([genesis, v2]) };
  }
  return { evidence, rotate, ...key(0), second: key(1) };
}

/** A published Original, a second device that has it, and a host client for each. */
async function shared() {
  const h = host();
  const author = await twoKeyAuthor(new Date(START));
  let ta = START + 1000;
  let tb = START + 1100;
  const sdkFor = (clock: () => number) => OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence], freshness: 'asserted', clock });
  const a = sdkFor(() => (ta += 250));
  const c = await a.create({ name: 'Harbor at dawn', resources: [{ id: 'artwork.svg', mediaType: 'image/svg+xml', bytes: SVG }], author: author.ref, signer: author.signer });
  if (c.kind !== 'original') throw new Error('expected an Original');
  const did = c.original.did;
  const secret = ed.utils.randomSecretKey();
  const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
  const published = await publishOriginal({ sdk: a, did, parent: c.original.checkpoint, author: author.ref, signer: author.signer, aliasSigner, domain: DOMAIN, slug: userWebvhSlug(SUB), hosting: h.upload });
  const aliasDid = published.alias.did;
  const b = sdkFor(() => (tb += 250));
  await b.import((await a.package(did)).bytes);
  const parent = (await a.get(did)).checkpoint;
  const siteKey = siteKeyOf(aliasDid);
  const hostA = landingSharedHost({ sdk: a, aliasDid, transport: h.adapterFor(SUB), read: h.read });
  const hostB = landingSharedHost({ sdk: b, aliasDid, transport: h.adapterFor(SUB2), read: h.read });
  const logPath = join(h.dataDir, 'hosted', siteKey, 'originals', 'asset', 'did.jsonl');
  const hostedLines = () => readFileSync(logPath, 'utf8').trimEnd().split('\n');
  /** POST a submission as `sub`, returning the raw HTTP response. */
  const post = (submission: Submission | string, sub: string | null = SUB) =>
    h.fetchAs(sub)(new Request(`http://app.local/api/originals/submit/${encodeURIComponent(siteKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof submission === 'string' ? submission : encodeSubmission(submission),
    }));
  const stranger = () => OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => LATER });
  const edit = async (sdk: OriginalsSDK, bytes: Uint8Array, signing: { ref: AuthorRef; signer: OriginalsSigner } = author) =>
    sdk.sign(await sdk.prepareEdit(did, { parent: (await sdk.get(did)).checkpoint, resources: [{ id: 'artwork.svg', bytes }], author: signing.ref }), signing.signer);
  return { h, author, a, b, did, parent, aliasDid, siteKey, hostA, hostB, logPath, hostedLines, post, stranger, edit };
}

/** Device A saves first; device B's save from the same parent is refused (C12-125). */
async function refusedOnB() {
  const env = await shared();
  const theirs = await env.a.submit(await env.edit(env.a, THEIRS), env.hostA);
  const mine = await env.edit(env.b, MINE);
  const refused = await env.b.submit(mine, env.hostB);
  if (theirs.status !== 'accepted' || refused.status !== 'stale-parent') throw new Error(`expected one acceptance and one refusal, got ${theirs.status} and ${refused.status}`);
  return { ...env, theirs, mine, refused };
}

/** A package of the refused candidate's branch, as someone publishing it elsewhere would make (C12-129). */
function elsewhere(env: Awaited<ReturnType<typeof refusedOnB>>): Uint8Array {
  const hosted = env.hostedLines();
  const through = hosted.slice(0, hosted.findIndex((l) => (parseJson(l) as { versionId: string }).versionId === env.parent) + 1);
  const log = `${[...through, env.mine.line].join('\n')}\n`;
  const manifest = { format: 'originals-evidence/0.1' as const, profile: 'originals:1.0' as const, original: env.did, checkpoint: env.mine.versionId, head: env.mine.versionId, completeness: 'complete' as const, missing: [] };
  return writeEvidence({ manifest, log, authors: [env.author.evidence], bytes: { [resourceDigest(SVG)]: SVG, [resourceDigest(MINE)]: MINE } });
}

describe('shared-host saves on the landing (P6.7, P6.8)', () => {
  test('C12-125: two submissions with the same parent: one accepted, the other refused with the new head; the refused candidate is kept, not published', async () => {
    const env = await refusedOnB();
    const { b, did, parent, mine, refused, theirs } = env;
    expect(refused.hostHead).toBe(theirs.checkpoint);
    expect(refused.refused.label).toBe('refused');
    expect(refused.refused.versionId).toBe(mine.versionId);
    expect((await b.refused(did)).map((r) => r.versionId)).toEqual([mine.versionId]);
    expect((await b.get(did)).checkpoint).toBe(parent);
    // The host published A's entry and nothing of B's: neither the entry nor its bytes.
    expect(env.hostedLines().some((l) => l.includes(mine.versionId))).toBe(false);
    expect(existsSync(join(env.h.dataDir, 'hosted', env.siteKey, 'originals', 'resources', resourceDigest(MINE)))).toBe(false);
    const r = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(theirs.checkpoint);
    // The raw answer: 409 with the head's checkpoint.
    const again = await env.post({ original: did, entry: mine.line, resources: {}, identities: [] }, SUB2);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ status: 'stale-parent', head: theirs.checkpoint });
    // B's SDK never submits it again (P6.8).
    await expect(b.submit(mine, env.hostB)).rejects.toMatchObject({ code: 'CANDIDATE_REFUSED' });
  });

  test('C12-126: a reconciled candidate signed by an authorized signer against the new head is accepted', async () => {
    const env = await refusedOnB();
    const { b, did, author, theirs, refused } = env;
    const result = await b.reconcile(did, {
      host: env.hostB,
      refused: refused.refused.versionId,
      author: author.ref,
      signer: author.signer,
      change: ({ head, refused: kept }) => {
        expect(head.checkpoint).toBe(theirs.checkpoint);
        return { resources: [{ id: 'artwork.svg', bytes: kept!.draft.bytes.get(resourceDigest(MINE))! }] };
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status === 'stale-parent') return;
    expect(result.hostHead).toBe(result.checkpoint);
    expect(env.hostedLines().length).toBe(4);
    // The refused candidate is kept, labelled with what carried its change, and never published (P6.8).
    const kept = await b.refused(did);
    expect(kept.map((r) => r.reconciledAs)).toEqual([result.checkpoint]);
    expect(env.hostedLines().some((l) => l.includes(kept[0].versionId))).toBe(false);
    const r = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(result.checkpoint);
    expect(r.report.state?.resources[0].digest).toBe(resourceDigest(MINE));
  });

  test('C12-127: the host stores the submission unchanged; a changed or re-signed entry fails verification or is not by an authorized signer', async () => {
    const env = await shared();
    const candidate = await env.edit(env.a, THEIRS);
    expect((await env.a.submit(candidate, env.hostA)).status).toBe('accepted');
    expect(env.hostedLines().at(-1)).toBe(candidate.line);

    const entry = parseJson(candidate.line) as unknown as LogEntry;
    // Changed: the name differs from what the author signed.
    const changed = { ...entry, state: { ...entry.state, asset: { ...(entry.state.asset as object), name: 'Harbor, by the host' } } };
    // Re-signed by the host's own key, over the author's entry (P5.2, P5.3).
    const hostKey = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
    const vm = `did:key:${hostKey.publicKeyMultibase}#${hostKey.publicKeyMultibase}`;
    const { proof: _proof, ...unsigned } = entry;
    const options = { type: 'DataIntegrityProof' as const, cryptosuite: 'eddsa-jcs-2022' as const, verificationMethod: vm, proofPurpose: 'assertionMethod' };
    const resigned = { ...unsigned, proof: [{ ...options, proofValue: multibaseEncode(await hostKey.sign(proofHashData(unsigned, options))) }] };
    const through = env.hostedLines().slice(0, -1);
    for (const bad of [changed, resigned]) {
      const report = await verifyOriginal({ log: `${[...through, JSON.stringify(bad)].join('\n')}\n`, authors: [env.author.evidence], now: LATER });
      expect(report.history.status === 'valid' && report.authorBinding.status === 'valid', JSON.stringify(report.history)).toBe(false);
      expect(report.current).toBe(false);
    }
    // A host that rewrites the accepted entry on disk serves a snapshot that gives no verified result:
    // with no verified checkpoint naming the alias, the reader returns nothing (ALIAS_NOT_CONFIRMED).
    for (const bad of [changed, resigned]) {
      writeFileSync(env.logPath, `${[...through, JSON.stringify(bad)].join('\n')}\n`);
      const outcome = await env.stranger().loadPublished(env.aliasDid, env.h.read).then((r) => r.verified, (e: { code?: string }) => e.code);
      expect([false, 'ALIAS_NOT_CONFIRMED']).toContain(outcome);
    }
  });

  test('C12-127: the host refuses, and never publishes, a changed or re-signed submission', async () => {
    const env = await shared();
    const candidate = await env.edit(env.a, THEIRS);
    const entry = parseJson(candidate.line) as unknown as LogEntry;
    const changed = JSON.stringify({ ...entry, state: { ...entry.state, asset: { ...(entry.state.asset as object), name: 'Changed' } } });
    // Signed under the author's verification method with a key the author DID does not list.
    const intruder = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
    const { proof, ...unsigned } = entry;
    const { proofValue: _value, ...options } = proof[0];
    const forged = JSON.stringify({ ...unsigned, proof: [{ ...options, proofValue: multibaseEncode(await intruder.sign(proofHashData(unsigned, options))) }] });
    const before = env.hostedLines();
    const resources = { [resourceDigest(THEIRS)]: THEIRS };
    expect((await env.post({ original: env.did, entry: changed, resources, identities: [env.author.evidence] })).status).toBe(409);
    const refusedForged = await env.post({ original: env.did, entry: forged, resources, identities: [env.author.evidence] });
    expect(refusedForged.status).toBe(422);
    expect(env.hostedLines()).toEqual(before);
    expect(existsSync(join(env.h.dataDir, 'hosted', env.siteKey, 'originals', 'resources', resourceDigest(THEIRS)))).toBe(false);
  });

  test('C12-128: a submission retried after a lost acknowledgement, including after the head moved on, returns its checkpoint and the current head; no second append', async () => {
    const env = await shared();
    const { a, b, did } = env;
    const candidate = await env.edit(b, MINE);
    // The host accepts B's save, but the answer never reaches B.
    const lost = await env.post({ original: did, entry: candidate.line, resources: { [resourceDigest(MINE)]: MINE }, identities: [env.author.evidence] }, SUB2);
    expect(lost.status).toBe(200);
    expect((await b.get(did)).checkpoint).toBe(env.parent);
    // A fetches the new head and saves on top of it.
    expect((await a.sync(did, env.hostA)).status).toBe('imported');
    const later = await a.submit(await env.edit(a, NOON), env.hostA);
    if (later.status !== 'accepted') throw new Error('expected acceptance');
    const lines = env.hostedLines().length;
    const retry = await b.submit(candidate, env.hostB);
    expect(retry).toMatchObject({ status: 'already-accepted', checkpoint: candidate.versionId, hostHead: later.checkpoint, behind: true });
    if (retry.status === 'stale-parent') return;
    expect(retry.original.checkpoint).toBe(candidate.versionId);
    // Raw retries of the same bytes: still the same answer, no conflict, no append.
    const raw = await env.post({ original: did, entry: candidate.line, resources: {}, identities: [] }, SUB2);
    expect(raw.status).toBe(200);
    expect(await raw.json()).toEqual({ status: 'already-accepted', checkpoint: candidate.versionId, head: later.checkpoint });
    expect(env.hostedLines().length).toBe(lines);
    expect(await b.refused(did)).toEqual([]);
  });

  test('C12-129: a refused candidate published elsewhere makes a fork that stays unresolved; the SDK never packages it', async () => {
    const env = await refusedOnB();
    const pkgB = await env.b.package(env.did);
    expect(new TextDecoder().decode(pkgB.bytes)).not.toContain(env.mine.versionId);
    const reader = env.stranger();
    expect((await reader.import((await env.a.package(env.did)).bytes)).status).toBe('imported');
    expect((await reader.import(elsewhere(env))).status).toBe('conflict');
    const view = await reader.get(env.did);
    expect(view.current).toBe(false);
    expect(view.report.fork?.branches.map((br) => br.versionId).sort()).toEqual([env.theirs.checkpoint, env.mine.versionId].sort());
  });

  test('C12-130: neither the longer branch nor the branch with more signing keys wins; the fork stays unresolved', async () => {
    const env = await refusedOnB();
    // Someone extends the refused branch elsewhere: two more entries, signed with both author keys.
    let tc = START + 30_000;
    const c = OriginalsSDK.create({ store: new MemoryStore(), authors: [env.author.evidence], freshness: 'asserted', clock: () => (tc += 250) });
    expect((await c.import(elsewhere(env))).status).toBe('imported');
    const e1 = await c.edit(env.did, { parent: env.mine.versionId, name: 'Harbor, second key', author: env.author.second.ref, signer: env.author.second.signer });
    await c.edit(env.did, { parent: e1.original.checkpoint, name: 'Harbor, longer', author: env.author.ref, signer: env.author.signer });
    const longer = (await c.package(env.did)).bytes;
    const hosted = (await env.a.package(env.did)).bytes;
    for (const order of [[hosted, longer], [longer, hosted]]) {
      const reader = env.stranger();
      for (const pkg of order) await reader.import(pkg);
      const view = await reader.get(env.did);
      expect(view.current).toBe(false);
      expect(view.report.fork?.branches.length).toBe(2);
    }
  });

  test('C12-131: an entry bringing in content from another branch is accepted on its branch as a single-parent entry; the fork remains', async () => {
    const env = await refusedOnB();
    const reader = env.stranger();
    await reader.import((await env.a.package(env.did)).bytes);
    await reader.import(elsewhere(env));
    // A brings B's artwork into the host's branch: an ordinary update with one parent.
    const bringing = await env.a.submit(await env.edit(env.a, MINE), env.hostA);
    expect(bringing.status).toBe('accepted');
    expect(env.hostedLines().length).toBe(4);
    const r = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.state?.resources[0].digest).toBe(resourceDigest(MINE));
    // A reader that knows the other branch still reports the fork, and nothing is current.
    expect((await reader.import((await env.a.package(env.did)).bytes)).status).toBe('imported');
    const view = await reader.get(env.did);
    expect(view.report.fork).not.toBeNull();
    expect(view.current).toBe(false);
  });

  test('two different submissions with the same parent fired at the route at once: exactly one append', async () => {
    const env = await shared();
    const one = await env.edit(env.a, THEIRS);
    const two = await env.edit(env.b, MINE);
    const before = env.hostedLines().length;
    const answers = await Promise.all([
      env.post({ original: env.did, entry: one.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] }),
      env.post({ original: env.did, entry: two.line, resources: { [resourceDigest(MINE)]: MINE }, identities: [env.author.evidence] }, SUB2),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(env.hostedLines().length).toBe(before + 1);
    const accepted = (await answers.find((r) => r.status === 200)!.json()) as { checkpoint: string };
    expect(env.hostedLines().at(-1)).toBe(accepted.checkpoint === one.versionId ? one.line : two.line);
  });

  test('the same submission fired twice at once: one accepted, one already accepted, one append', async () => {
    const env = await shared();
    const one = await env.edit(env.a, THEIRS);
    const body = { original: env.did, entry: one.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] };
    const before = env.hostedLines().length;
    const answers = await Promise.all([env.post(body), env.post(body)]);
    const statuses = (await Promise.all(answers.map((r) => r.json()))).map((j) => (j as { status: string }).status).sort();
    expect(statuses).toEqual(['accepted', 'already-accepted']);
    expect(env.hostedLines().length).toBe(before + 1);
  });

  test('the route needs a signed-in caller, a hosted Original, a canonical entry and every new resource\'s bytes', async () => {
    const env = await shared();
    const one = await env.edit(env.a, THEIRS);
    const before = env.hostedLines();
    const full = { original: env.did, entry: one.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] };
    expect((await env.post(full, null)).status).toBe(401);
    expect((await env.post('not json')).status).toBe(400);
    expect((await env.post({ ...full, entry: JSON.stringify(parseJson(one.line), null, 1) })).status).toBe(400);
    expect((await env.post({ ...full, original: 'did:vh:other' })).status).toBe(400);
    expect((await env.post({ ...full, resources: {} })).status).toBe(422);
    expect((await env.post({ ...full, resources: { [resourceDigest(THEIRS)]: MINE } })).status).toBe(422);
    expect(env.hostedLines()).toEqual(before);
    const elsewhereKey = encodeURIComponent(`${DOMAIN}/${userWebvhSlug(SUB)}/o-111111111111111a`);
    const missing = await env.h.fetchAs(SUB)(new Request(`http://app.local/api/originals/submit/${elsewhereKey}`, { method: 'POST', body: encodeSubmission(full) }));
    expect(missing.status).toBe(404);
    // Accepted from the second account; the files stay the namespace owner's.
    expect((await env.post(full, SUB2)).status).toBe(200);
    expect(readFileSync(`${env.logPath}.owner`, 'utf8')).toBe(SUB);
    const served = await env.h.serve(new Request(`http://${env.siteKey}/originals/resources/${resourceDigest(THEIRS)}`));
    expect(served.headers.get('content-type')).toBe('image/svg+xml');
    // The manifest names the new head, so the snapshot is the accepted checkpoint (P9.1).
    const manifest = JSON.parse(readFileSync(join(env.h.dataDir, 'hosted', env.siteKey, 'originals', 'originals-evidence.json'), 'utf8')) as { checkpoint: string; head: string };
    expect([manifest.checkpoint, manifest.head]).toEqual([one.versionId, one.versionId]);
  });

  test('re-uploading an older asset log cannot roll back the accepted head: a retried first publication is already published (08d review r2 #9)', async () => {
    const env = await shared();
    const old = readFileSync(env.logPath);
    const manifestKey = `${env.siteKey}/originals/originals-evidence.json`;
    const oldManifest = readFileSync(join(env.h.dataDir, 'hosted', manifestKey));
    expect((await env.a.submit(await env.edit(env.a, THEIRS), env.hostA)).status).toBe('accepted');
    const after = readFileSync(env.logPath, 'utf8');
    const newManifest = readFileSync(join(env.h.dataDir, 'hosted', manifestKey), 'utf8');
    // The publisher retries its first publication: the log it sent then, and its manifest.
    const put = (key: string, body: Uint8Array) => env.h.fetchAs(SUB)(new Request(`http://app.local/api/originals/host/${encodeURIComponent(key)}`, { method: 'PUT', body }));
    const retried = await put(`${env.siteKey}/originals/asset/did.jsonl`, old);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ alreadyPublished: true });
    expect((await put(manifestKey, oldManifest)).status).toBe(200);
    // Nothing was written: no rollback of the save.
    expect(readFileSync(env.logPath, 'utf8')).toBe(after);
    expect(readFileSync(join(env.h.dataDir, 'hosted', manifestKey), 'utf8')).toBe(newManifest);
    expect(env.hostedLines().length).toBe(3);
    // A log that is not a prefix of whole lines is still refused.
    expect((await put(`${env.siteKey}/originals/asset/did.jsonl`, old.subarray(0, old.length - 1))).status).toBe(409);
    const reader = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(reader.verified, JSON.stringify(reader.reasons)).toBe(true);
  });
});

describe('review of the shared-host route (C1, C4, C6, C7, R4, P1, P4)', () => {
  const { createOriginalsStore } = require('../../server/originals-store') as typeof import('../../server/originals-store');
  const { createSharedSaves, parseSubmission } = require('../../server/shared-saves') as typeof import('../../server/shared-saves');
  const { authorPath } = require('@originals/sdk/originals') as typeof import('@originals/sdk/originals');

  /** A third device whose author DID is at v2 (key 0 removed, or deactivated). */
  async function rotated(deactivate: boolean) {
    const env = await shared();
    const v2 = await env.author.rotate(new Date(START + 2000), { deactivate });
    let tc = START + 5000;
    const c = OriginalsSDK.create({ store: new MemoryStore(), authors: [v2], freshness: 'asserted', clock: () => (tc += 250) });
    expect((await c.import((await env.a.package(env.did)).bytes)).status).toBe('imported');
    const hostC = landingSharedHost({ sdk: c, aliasDid: env.aliasDid, transport: env.h.adapterFor(SUB2), read: env.h.read });
    const didPath = `${env.siteKey}/originals/${authorPath(env.author.evidence.did)}/did.jsonl`;
    return { ...env, v2, c, hostC, didPath };
  }

  test('C12-127: an entry signed with a key the latest author DID state removed is refused, never published (P7.9)', async () => {
    const env = await rotated(false);
    // The author saves legitimately with key 1; the host now holds the v2 author DID log.
    expect((await env.c.submit(await env.edit(env.c, THEIRS, env.author.second), env.hostC)).status).toBe('accepted');
    const before = env.hostedLines();
    // A thief holding the removed key 0 signs against the new head.
    const thief = await env.edit(env.c, MINE, env.author);
    const res = await env.post({ original: env.did, entry: thief.line, resources: { [resourceDigest(MINE)]: MINE }, identities: [env.author.evidence] }, SUB2);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'entry_not_current', reasons: expect.arrayContaining(['head-key-not-in-latest-author-document']) });
    expect(env.hostedLines()).toEqual(before);
  });

  test('C12-127: an entry by an author whose DID the host knows is deactivated is refused (P6.5)', async () => {
    const env = await rotated(true);
    // The owner uploads the deactivated author DID log, which extends the stored one.
    expect((await env.h.fetchAs(SUB)(new Request(`http://app.local/api/originals/host/${encodeURIComponent(env.didPath)}`, { method: 'PUT', body: env.v2.log as string }))).status).toBe(200);
    const thief = await env.edit(env.a, MINE, env.author);
    const res = await env.post({ original: env.did, entry: thief.line, resources: { [resourceDigest(MINE)]: MINE }, identities: [env.author.evidence] }, SUB2);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'entry_not_current', reasons: expect.arrayContaining(['author-did-deactivated']) });
  });

  test('once hosted, the asset log changes only through the verifying submit route: a PUT that extends it is refused (C4)', async () => {
    const env = await shared();
    const current = readFileSync(env.logPath, 'utf8');
    const put = (body: string) => env.h.fetchAs(SUB)(new Request(`http://app.local/api/originals/host/${encodeURIComponent(`${env.siteKey}/originals/asset/did.jsonl`)}`, { method: 'PUT', body }));
    expect((await put(current)).status).toBe(200); // a retried publication of the same log (P9.2)
    // A chained entry with a forged signature, appended by PUT, never becomes the head.
    const forged = parseJson((await env.edit(env.a, THEIRS)).line) as { proof: Array<{ proofValue: string }> };
    forged.proof[0].proofValue = `z${'1'.repeat(80)}`;
    const res = await put(`${current}${JSON.stringify(forged)}\n`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'asset_log_changes_through_submit' });
    expect(readFileSync(env.logPath, 'utf8')).toBe(current);
    const reader = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(reader.verified, JSON.stringify(reader.reasons)).toBe(true);
    // Shared saves still work.
    expect((await env.b.submit(await env.edit(env.b, MINE), env.hostB)).status).toBe('accepted');
  });

  test('C12-128: the log write is the commit point: a manifest write that fails after it still answers accepted, and the next request repairs it (C6)', async () => {
    const env = await shared();
    const real = createOriginalsStore({ dataDir: env.h.dataDir });
    let full = true;
    const store = { ...real, saveBytes: (o: string, k: string, b: Uint8Array, c: string) => { if (full && k.endsWith('originals-evidence.json')) throw new Error('STORE_FULL'); return real.saveBytes(o, k, b, c); } };
    const saves = createSharedSaves({ store, now: () => Date.now() });
    const cand = await env.edit(env.b, THEIRS);
    const parsed = parseSubmission(encodeSubmission({ original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] }));
    if ('http' in parsed) throw new Error('expected a submission');
    const res = await saves.submit(env.siteKey, parsed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'accepted', checkpoint: cand.versionId });
    expect(env.hostedLines().at(-1)).toBe(cand.line);
    const manifestPath = join(env.h.dataDir, 'hosted', env.siteKey, 'originals', 'originals-evidence.json');
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { checkpoint: string }).checkpoint).not.toBe(cand.versionId);
    full = false;
    expect((await saves.submit(env.siteKey, parsed)).status).toBe(200); // a retry: already accepted
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { checkpoint: string }).checkpoint).toBe(cand.versionId);
  });

  test('cheap checks come before full verification: a proof that does not verify with the signer key is refused at once (C7)', async () => {
    const env = await shared();
    const cand = parseJson((await env.edit(env.a, THEIRS)).line) as { proof: Array<{ proofValue: string }> };
    cand.proof[0].proofValue = `z${'2'.repeat(86)}`;
    const res = await env.post({ original: env.did, entry: JSON.stringify(cand), resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [] }, 'random-stranger');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'proof_invalid' });
  });

  test('a submission is bounded: identity count and size, resources, and the body counted in bytes as it arrives (C7, R4)', async () => {
    const env = await shared();
    const cand = await env.edit(env.a, THEIRS);
    const body = { original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS } };
    const many = Array.from({ length: 40 }, () => env.author.evidence);
    const tooMany = await env.post({ ...body, identities: many });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: 'too_many_identities' });
    const big = await env.post({ ...body, identities: [{ did: env.author.evidence.did, log: 'x'.repeat(3 * 1024 * 1024) }] });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: 'identity_too_large' });
    // A chunked body with no length is cut off once past the cap, not read to the end.
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (pulled++ < 60) c.enqueue(chunk); else c.close(); } });
    const url = `http://app.local/api/originals/submit/${encodeURIComponent(env.siteKey)}`;
    // Straight to the server, as Bun.serve hands it a request (re-wrapping a streamed request is not what a server sees).
    const chunked = await env.h.serve(new Request(url, { method: 'POST', headers: { cookie: cookieFor(SUB) }, body: stream, duplex: 'half' } as RequestInit));
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(30);
    // The cap counts bytes: 6 million three-byte characters are 18 MB, though 6 million characters.
    const wide = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('€'.repeat(6_000_000))); c.close(); } });
    expect((await env.h.serve(new Request(url, { method: 'POST', headers: { cookie: cookieFor(SUB) }, body: wide, duplex: 'half' } as RequestInit))).status).toBe(413);
  });

  test('queued submissions for one Original are bounded: past the limit the host answers busy (R4)', async () => {
    const env = await shared();
    const cand = await env.edit(env.a, THEIRS);
    const body = { original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] };
    const answers = await Promise.all(Array.from({ length: 30 }, () => env.post(body)));
    const statuses = answers.map((r) => r.status);
    expect(statuses).toContain(503);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(env.hostedLines().filter((l) => l === cand.line)).toHaveLength(1);
  });

  test('identity evidence is checked again in the step that appends: a DID log changed during verification is not overwritten or ignored (P1)', async () => {
    const env = await rotated(true);
    const real = createOriginalsStore({ dataDir: env.h.dataDir });
    let raced = false;
    // The owner uploads the deactivated author DID log while the submission is being verified.
    const now = () => {
      if (!raced) {
        raced = true;
        real.saveBytes(SUB, env.didPath, new TextEncoder().encode(env.v2.log as string), 'application/jsonl');
      }
      return Date.now();
    };
    const saves = createSharedSaves({ store: real, now });
    const thief = await env.edit(env.a, MINE, env.author);
    const parsed = parseSubmission(encodeSubmission({ original: env.did, entry: thief.line, resources: { [resourceDigest(MINE)]: MINE }, identities: [env.author.evidence] }));
    if ('http' in parsed) throw new Error('expected a submission');
    const res = await saves.submit(env.siteKey, parsed);
    expect(raced).toBe(true);
    expect(res.status).toBe(422);
    expect(readFileSync(join(env.h.dataDir, 'hosted', env.didPath), 'utf8')).toBe(env.v2.log as string);
  });

  test('bytes from a save that failed before its log write are not served; served resources take the log\'s media type (P4, P9.7)', async () => {
    const env = await shared();
    const real = createOriginalsStore({ dataDir: env.h.dataDir });
    const store = { ...real, saveBytes: (o: string, k: string, b: Uint8Array, c: string) => { if (k.endsWith('asset/did.jsonl')) throw new Error('STORE_FULL'); return real.saveBytes(o, k, b, c); } };
    const saves = createSharedSaves({ store, now: () => Date.now() });
    const cand = await env.edit(env.b, THEIRS);
    const parsed = parseSubmission(encodeSubmission({ original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [env.author.evidence] }));
    if ('http' in parsed) throw new Error('expected a submission');
    expect((await saves.submit(env.siteKey, parsed)).status).toBe(507);
    const resourceUrl = `http://${env.siteKey}/originals/resources/${resourceDigest(THEIRS)}`;
    expect((await env.h.serve(new Request(resourceUrl))).status).toBe(404);
    // Accepted later, it is served, with the media type its descriptor declares whatever the sidecar says.
    expect((await env.b.submit(cand, env.hostB)).status).toBe('accepted');
    writeFileSync(join(env.h.dataDir, 'hosted', env.siteKey, 'originals', 'resources', `${resourceDigest(THEIRS)}.ctype`), 'text/html');
    const served = await env.h.serve(new Request(resourceUrl));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/svg+xml');
  });

  test('#965 / 08d review r2 #6: junk appended to the signer DID log cannot poison the Original; a verified log repairs it', async () => {
    const env = await rotated(false);
    const junk = `${env.author.evidence.log as string}{"junk":1}\n`;
    const putDid = (body: string) => env.h.fetchAs(SUB)(new Request(`http://app.local/api/originals/host/${encodeURIComponent(env.didPath)}`, { method: 'PUT', body }));
    // PUT: bytes that extend the stored log but do not verify are refused.
    const put = await putDid(junk);
    expect(put.status).toBe(422);
    // Submit: a junk-extended signer log is refused, and nothing is written.
    const before = env.hostedLines();
    const cand = await env.edit(env.c, THEIRS, env.author.second);
    const viaSubmit = await env.post({ original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [{ did: env.v2.did, log: `${env.v2.log as string}{"junk":1}\n` }] }, SUB2);
    expect(viaSubmit.status).toBe(422);
    expect(await viaSubmit.json()).toMatchObject({ error: 'identity_log_invalid' });
    expect(env.hostedLines()).toEqual(before);
    // A stored log poisoned before this rule: the legitimate rotated save still lands and repairs it.
    writeFileSync(join(env.h.dataDir, 'hosted', env.didPath), junk);
    expect((await env.c.submit(cand, env.hostC)).status).toBe('accepted');
    expect(readFileSync(join(env.h.dataDir, 'hosted', env.didPath), 'utf8')).toBe(env.v2.log as string);
    const reader = await env.stranger().loadPublished(env.aliasDid, env.h.read);
    expect(reader.verified, JSON.stringify(reader.reasons)).toBe(true);
  });

  test('08d review r2 #7, r4 #3: a submitted witness file is bounded and stored only when the submitted log needs it and verifies with it', async () => {
    const env = await rotated(false);
    const witnessPath = join(env.h.dataDir, 'hosted', env.didPath.replace(/did\.jsonl$/, 'did-witness.json'));
    const cand = await env.edit(env.c, THEIRS, env.author.second);
    const body = (witness: unknown) => ({ original: env.did, entry: cand.line, resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [{ ...env.v2, witness } as AuthorDidEvidence] });
    // Counted in the identity byte cap.
    const big = await env.post(body([{ versionId: '1-x', proof: [{ v: 'x'.repeat(2 * 1024 * 1024) }] }]), SUB2);
    expect(big.status).toBe(413);
    // A file that would not be written is not judged: this DID log is not witnessed, so the stored file stays.
    const v2Id = (JSON.parse((env.v2.log as string).trimEnd().split('\n')[1]) as { versionId: string }).versionId;
    const kept = JSON.stringify([{ versionId: v2Id, proof: [{ proofValue: 'z1' }] }]);
    writeFileSync(witnessPath, kept);
    const ignored = await env.post(body({ injected: '<script>alert(1)</script>'.repeat(1000) }), SUB2);
    expect(ignored.status).toBe(200);
    expect(readFileSync(witnessPath, 'utf8')).toBe(kept);
    rmSync(witnessPath);
    expect((await env.h.read(`https://${env.didPath.replace(/did\.jsonl$/, 'did-witness.json')}`).then(() => 'served', () => 'absent'))).toBe('absent');
  });

  test('08d review r2 #8: an entry naming a signer version absent from the host\'s DID log is refused before full verification', async () => {
    const env = await shared();
    const e = parseJson((await env.edit(env.a, THEIRS)).line) as Record<string, any>;
    const { vhHash } = await import('@originals/vh/log');
    const lines = env.hostedLines();
    const head = (JSON.parse(lines[lines.length - 1]) as { versionId: string }).versionId;
    const { proof, versionId: _v, ...rest } = e;
    const forged: Record<string, any> = { ...rest, state: { ...rest.state, author: { ...rest.state.author, versionId: '7-QmFake' } } };
    forged.versionId = `${Number(head.split('-')[0]) + 1}-${vhHash({ ...forged, versionId: head })}`;
    const ordered = { versionId: forged.versionId, versionTime: forged.versionTime, parameters: forged.parameters, state: forged.state, proof: [{ ...proof[0], proofValue: `z${'2'.repeat(86)}` }] };
    const res = await env.post({ original: env.did, entry: JSON.stringify(ordered), resources: { [resourceDigest(THEIRS)]: THEIRS }, identities: [] }, 'random-stranger');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'signer_version_unavailable', versionId: '7-QmFake' });
  });
});
