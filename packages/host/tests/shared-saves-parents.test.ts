/**
 * Shared-host saves for a child Original (P5.24–P5.27, P7.1, P14.10): the
 * submission carries the parent's log through the highest pin, with the
 * parent's signers, in the layout an evidence package uses
 * (`parents/<sha256(did)>/did.jsonl`). The host verifies the entry with it
 * and accepts or refuses it; without it the entry is incomplete and refused,
 * never accepted.
 *
 * Rows C12-398 (an inherited grant allows a change), C12-399 (revoked:
 * historically authorized only), C12-401 (missing parent evidence is
 * incomplete) and C12-411 (the parent's log through the highest pin).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import {
  MemoryStore, OriginalsSDK, encodeSubmission, keySigner, parentPath, readHostAnswer, readZip, signerPath,
  type AuthorRef, type OriginalsSigner, type SharedHost, type Submission,
} from '@originals/sdk/originals';
import { createOriginalsStore } from '../src/originals-store.js';
import { SUBMISSION_LIMITS, createSharedSaves, parseSubmission } from '../src/shared-saves.js';
import { classifyHostedKey, parentLogVerdict } from '../src/hosted-layout.js';

const enc = (s: string) => new TextEncoder().encode(s);
const OWNER = { sub: 'sub-owner-0001', slug: 'owner' };
const SITE = 'host.example/owner/o-9xKpQ2mN4vR7tW1z';

/** A did:vh signer DID with one assertionMethod key `#k`. */
async function person(seed: number) {
  const update = localSigner('Ed25519', new Uint8Array(32).fill(seed));
  const secret = new Uint8Array(32).fill(seed + 1);
  const key = localSigner('Ed25519', secret);
  const genesis = await createLog({
    versionTime: '2026-11-01T00:00:00Z',
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [update.publicKeyMultibase] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#k', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: key.publicKeyMultibase }],
      assertionMethod: ['did:vh:{SCID}#k'],
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` }),
  });
  const did = genesis.state.id as string;
  const ref: AuthorRef = { did, verificationMethod: `${did}#k`, versionId: genesis.versionId };
  const signer: OriginalsSigner = keySigner({ keyType: 'Ed25519', secretKey: secret, verificationMethod: `${did}#k` });
  return { did, ref, signer, evidence: { did, log: serializeLog([genesis]) } };
}

/**
 * Alice's repository grants Dana the resource; Bob's branch names it as its
 * parent and is hosted, unpacked from its evidence package, in Bob's
 * namespace. The host's store and shared saves are real.
 */
async function hostedChild(opts: { hostParent?: boolean } = {}) {
  const [alice, bob, dana] = await Promise.all([person(10), person(20), person(30)]);
  let t = Date.parse('2026-11-19T00:00:00Z');
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence, bob.evidence, dana.evidence], clock: () => (t += 1000) });
  const repo = await sdk.create({ name: 'Repository', resource: { mediaType: 'application/octet-stream', bytes: enc('repo v1') }, author: alice.ref, signer: alice.signer });
  if (repo.kind !== 'original') throw new Error('expected an Original');
  const granted = await sdk.edit(repo.original.did, { parent: repo.original.checkpoint, editors: [{ did: dana.did, name: false, metadata: false, resource: true }], author: alice.ref, signer: alice.signer });
  const pin = granted.original.checkpoint;
  const branch = await sdk.create({ name: 'Branch', resource: { mediaType: 'application/octet-stream', bytes: enc('branch v1') }, author: bob.ref, signer: bob.signer, parent: { did: repo.original.did, versionId: pin } });
  if (branch.kind !== 'original') throw new Error('expected an Original');

  const dataDir = mkdtempSync(join(tmpdir(), 'shared-parents-'));
  const store = createOriginalsStore({ dataDir });
  for (const [path, bytes] of readZip((await sdk.package(branch.original.did)).bytes)) {
    if (opts.hostParent === false && path.startsWith('parents/')) continue;
    store.saveBytes(OWNER.sub, `${SITE}/originals/${path}`, bytes, path.endsWith('.json') ? 'application/json' : 'application/jsonl');
  }
  const saves = createSharedSaves({ store, now: () => t });
  const sent: Submission[] = [];
  /** The SDK's own client half, through the wire format, to the host's submit. */
  const sharedHost = (edit: (s: Submission) => Submission = (s) => s): SharedHost => ({
    async submit(submission) {
      const s = edit(submission);
      sent.push(s);
      const parsed = parseSubmission(encodeSubmission(s));
      if ('http' in parsed) return readHostAnswer(parsed.http, parsed.body);
      const res = await saves.submit(SITE, parsed, OWNER);
      return readHostAnswer(res.status, await res.json());
    },
    accepted: () => Promise.reject(new Error('not used')),
  });
  const hosted = (path: string) => {
    const file = join(dataDir, 'hosted', SITE, 'originals', path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  return { alice, bob, dana, sdk, repo: repo.original.did, pin, branch: branch.original.did, b1: branch.original.checkpoint, store, saves, sharedHost, sent, hosted };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const e = (await promise.then(() => undefined, (error: unknown) => error)) as { status?: number; body?: Record<string, unknown> } | undefined;
  if (!e || e.status === undefined) throw new Error(`expected a refusal, got ${String(e)}`);
  return { status: e.status, body: e.body ?? {} };
}

describe('C12-398, C12-411 (P5.24, P5.25, P7.1): a child entry submitted with its parent evidence', () => {
  test('the SDK sends the parent log through the highest pin and its signers; the host accepts an inherited-grant edit and stores them', async () => {
    const env = await hostedChild();
    // The repository moves on after the pin: the submission still carries it only through the pin.
    await env.sdk.edit(env.repo, { parent: env.pin, name: 'Repository, later', author: env.alice.ref, signer: env.alice.signer });
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, resource: { bytes: enc('branch v2 by Dana') }, pin: env.pin, editor: env.dana.ref }), env.dana.signer);
    const result = await env.sdk.submit(candidate, env.sharedHost());
    expect(result.status).toBe('accepted');
    const s = env.sent[0];
    expect(s.parents?.map((p) => p.did)).toEqual([env.repo]);
    expect(s.parents![0].log.trimEnd().split('\n').map((l) => JSON.parse(l).versionId).at(-1)).toBe(env.pin);
    // The parent's signer (Alice) is sent with the child's (Bob, Dana).
    expect(s.identities.map((i) => i.did).sort()).toEqual([env.alice.did, env.bob.did, env.dana.did].sort());
    // Stored in the evidence package layout (P14.10), with the parent's signer beside the child's.
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)).toBe(s.parents![0].log);
    expect(env.hosted(`${signerPath(env.alice.did)}/did.jsonl`)).not.toBeNull();
    expect(env.hosted('asset/did.jsonl')!.trimEnd().split('\n').at(-1)).toBe(candidate.line);
    const manifest = JSON.parse(env.hosted('originals-evidence.json')!);
    expect(manifest).toMatchObject({ checkpoint: candidate.versionId, completeness: 'complete', missing: [] });
  });

  test('an Original with no parent sends no parents member, exactly as before', async () => {
    const env = await hostedChild();
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.repo, { parent: env.pin, name: 'Repository, renamed', author: env.alice.ref }), env.alice.signer);
    const sent: Submission[] = [];
    await env.sdk.submit(candidate, { submit: (s) => (sent.push(s), Promise.resolve({ status: 'accepted', checkpoint: candidate.versionId, head: candidate.versionId })), accepted: () => Promise.reject(new Error('unused')) });
    expect('parents' in sent[0]).toBe(false);
    expect(JSON.parse(encodeSubmission(sent[0]))).not.toHaveProperty('parents');
  });
});

describe('C12-401 (P5.25, P7.4): missing parent evidence is incomplete, never a pass', () => {
  test('with no parent log submitted or hosted, the host refuses the entry as incomplete and writes nothing', async () => {
    const env = await hostedChild({ hostParent: false });
    const before = env.hosted('asset/did.jsonl');
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const dropParents = ({ parents: _parents, ...rest }: Submission): Submission => rest;
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost(dropParents)));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'entry_invalid', failure: { code: 'PARENT_EVIDENCE_MISSING', category: 'incomplete-evidence' } });
    expect(env.hosted('asset/did.jsonl')).toBe(before);
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)).toBeNull();
    // The same entry with its parent evidence is accepted, and the parent log is then hosted.
    expect((await env.sdk.submit(candidate, env.sharedHost())).status).toBe('accepted');
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)).not.toBeNull();
  });

  test('a parent log that stops before the pin leaves the pinned version missing: refused, not accepted', async () => {
    const env = await hostedChild({ hostParent: false });
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const genesisOnly = (s: Submission): Submission => ({ ...s, parents: s.parents!.map((p) => ({ did: p.did, log: `${p.log.split('\n')[0]}\n` })) });
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost(genesisOnly)));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'entry_invalid', failure: { code: 'PARENT_VERSION_MISSING' } });
  });

  test('a parent log that does not verify is refused, and the hosted files are unchanged', async () => {
    const env = await hostedChild({ hostParent: false });
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const tampered = (s: Submission): Submission => ({ ...s, parents: s.parents!.map((p) => ({ did: p.did, log: p.log.replace('"Repository"', '"Repositorz"') })) });
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost(tampered)));
    expect(r.status).toBe(422);
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)).toBeNull();
  });
});

describe('C12-399 (P5.26): an inherited grant the parent has since revoked', () => {
  test('when the host holds the revocation, an entry relying on the earlier pin is historically authorized only and refused', async () => {
    const env = await hostedChild();
    const revoked = await env.sdk.edit(env.repo, { parent: env.pin, editors: null, author: env.alice.ref, signer: env.alice.signer });
    // Bob's entry pins the revocation; the host keeps the longer parent log it was sent.
    const byBob = await env.sdk.submit(await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer), env.sharedHost());
    expect(byBob.status).toBe('accepted');
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)!.trimEnd().split('\n').map((l) => JSON.parse(l).versionId).at(-1)).toBe(revoked.original.checkpoint);
    // Dana can no longer sign an entry pinning the revocation (no grant there), and the pin never goes back.
    const c = await env.sdk.prepareEdit(env.branch, { parent: byBob.checkpoint, resource: { bytes: enc('late') }, editor: env.dana.ref }).then(
      () => 'prepared',
      (e: { code?: string }) => e.code,
    );
    expect(c).toBe('EDITOR_NOT_GRANTED');
  });

  test('an earlier-pinned editor entry, submitted when the host holds a later revoking parent version, is refused as historically authorized only', async () => {
    const env = await hostedChild();
    // Dana's entry pins the grant; then Alice revokes it and the owner hosts the longer parent log.
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, resource: { bytes: enc('by Dana') }, pin: env.pin, editor: env.dana.ref }), env.dana.signer);
    await env.sdk.edit(env.repo, { parent: env.pin, editors: null, author: env.alice.ref, signer: env.alice.signer });
    const repoLog = readZip((await env.sdk.package(env.repo)).bytes).get('asset/did.jsonl')!;
    const key = `${SITE}/originals/${parentPath(env.repo)}/did.jsonl`;
    expect(parentLogVerdict(env.store.readHosted(key), repoLog, parentPath(env.repo).slice('parents/'.length))).toBeNull();
    env.store.saveBytes(OWNER.sub, key, repoLog, 'application/jsonl');
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost()));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'entry_historically_authorized_only', reason: 'inherited-grant-revoked' });
  });
});

describe('the parent log the host holds only grows (P5.25, P5.26)', () => {
  test('a submitted parent log diverging from the held one is a conflict, never a silent choice', async () => {
    const env = await hostedChild();
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const other = (s: Submission): Submission => ({ ...s, parents: s.parents!.map((p) => ({ did: p.did, log: `${p.log.split('\n')[0]}\n{"versionId":"2-x"}\n` })) });
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost(other)));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'parent_evidence_conflict', did: env.repo });
  });

  test('a submitted prefix of the held parent log leaves the held one in use', async () => {
    const env = await hostedChild();
    const held = env.hosted(`${parentPath(env.repo)}/did.jsonl`);
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const genesisOnly = (s: Submission): Submission => ({ ...s, parents: s.parents!.map((p) => ({ did: p.did, log: `${p.log.split('\n')[0]}\n` })) });
    expect((await env.sdk.submit(candidate, env.sharedHost(genesisOnly))).status).toBe('accepted');
    expect(env.hosted(`${parentPath(env.repo)}/did.jsonl`)).toBe(held);
  });

  test('a parent the child does not name is refused', async () => {
    const env = await hostedChild();
    const candidate = await env.sdk.sign(await env.sdk.prepareEdit(env.branch, { parent: env.b1, name: 'Branch, renamed', author: env.bob.ref }), env.bob.signer);
    const extra = (s: Submission): Submission => ({ ...s, parents: [...s.parents!, { did: 'did:vh:QmNotTheParentNotTheParentXyz', log: '{}\n' }] });
    const r = await refusal(env.sdk.submit(candidate, env.sharedHost(extra)));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'parent_not_named' });
  });

  test('hosted layout: parents/<hex>/did.jsonl is part of it; an upload must name that DID and keep every stored line', async () => {
    const env = await hostedChild();
    const hex = parentPath(env.repo).slice('parents/'.length);
    expect(classifyHostedKey(`${SITE}/originals/parents/${hex}/did.jsonl`, OWNER.slug)).toMatchObject({ kind: 'evidence', contentType: 'application/jsonl', parentHex: hex });
    expect(classifyHostedKey(`${SITE}/originals/parents/${hex}/did-witness.json`, OWNER.slug)).toBeNull();
    expect(classifyHostedKey(`${SITE}/originals/parents/nothex/did.jsonl`, OWNER.slug)).toBeNull();
    const held = env.store.readHosted(`${SITE}/originals/parents/${hex}/did.jsonl`)!;
    const genesis = enc(`${new TextDecoder().decode(held).split('\n')[0]}\n`);
    expect(parentLogVerdict(held, genesis, hex)).toBe('parent_log_not_extending');
    expect(parentLogVerdict(null, genesis, 'a'.repeat(64))).toBe('parent_log_invalid');
    expect(parentLogVerdict(null, genesis, hex)).toBeNull();
    expect(parentLogVerdict(held, held, hex)).toBeNull();
  });
});

describe('a submission\'s parents are bounded (PROVISIONAL)', () => {
  const base = { original: 'did:vh:x', entry: '{"versionId":"1-x"}', resources: {}, identities: [] };
  const parse = (parents: unknown) => parseSubmission(JSON.stringify({ ...base, parents }));
  test('at most the nesting limit, each a did:vh with a log, no DID twice, each log within its byte bound', () => {
    const did = (i: number) => `did:vh:Qm${String(i).padStart(30, 'a')}`;
    expect('http' in parse([{ did: did(1), log: '{}' }])).toBe(false);
    expect(parse(Array.from({ length: SUBMISSION_LIMITS.parents + 1 }, (_, i) => ({ did: did(i), log: '{}' })))).toMatchObject({ http: 400, body: { error: 'too_many_parents' } });
    expect(parse([{ did: did(1), log: '{}' }, { did: did(1), log: '{}' }])).toMatchObject({ http: 400 });
    expect(parse([{ did: 'did:webvh:x:host.example', log: '{}' }])).toMatchObject({ http: 400 });
    expect(parse([{ did: did(1) }])).toMatchObject({ http: 400 });
    expect(parse([{ did: did(1), log: '{}', extra: true }])).toMatchObject({ http: 400 });
    expect(parse({})).toMatchObject({ http: 400 });
    expect(parse([{ did: did(1), log: 'x'.repeat(SUBMISSION_LIMITS.parentBytes + 1) }])).toMatchObject({ http: 413, body: { error: 'parent_too_large' } });
  });
});
