import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { signToken } from '@originals/auth/server';
import { OriginalsSDK } from '@originals/sdk/originals';
import { FileStore } from '@originals/sdk/originals/fs';
import { createOriginalsRoutes } from '../originals-routes';
import { createOriginalsStore } from '../originals-store';
import { createAnchoringLibrary } from '../originals-library';
import { authorWithOriginal } from './originals-chain-fixture';

const secret = 'library-test-secret-at-least-32-chars';
const request = (account?: string) => new Request('http://landing.test/api/originals', { headers: account ? { Authorization: `Bearer ${signToken(account, `${account}@example.test`, undefined, { secret })}` } : {} });

test('account library and evidence are authenticated, private, and available with all publication gates off (P7.5)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'originals-library-routes-'));
  const a = await authorWithOriginal();
  const dir = join(dataDir, 'originals-anchoring', 'alice', hex.encode(sha256(new TextEncoder().encode(a.did))));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'did'), a.did);
  const sdk = OriginalsSDK.create({ store: await FileStore.open(join(dir, 'store')), authors: [] });
  await sdk.import((await a.sdk.package(a.did)).bytes);
  const routes = createOriginalsRoutes({ jwtSecret: secret, store: createOriginalsStore({ dataDir }), library: createAnchoringLibrary(dataDir) });
  const url = new URL(`http://landing.test/api/originals/evidence?did=${encodeURIComponent(a.did)}`);
  expect((await routes.list(request(), url)).status).toBe(401);
  expect((await routes.evidence(request(), url)).status).toBe(401);
  expect(await (await routes.list(request('bob'), url)).json()).toEqual({ originals: [] });
  expect((await routes.evidence(request('bob'), url)).status).toBe(404);
  const listed = await routes.list(request('alice'), url);
  expect(listed.headers.get('cache-control')).toBe('no-store');
  expect(await listed.json()).toMatchObject({ originals: [{ did: a.did, availability: 'server' }] });
  const exported = await routes.evidence(request('alice'), url);
  expect(exported.status).toBe(200);
  expect(exported.headers.get('cache-control')).toBe('no-store');
  const report = (await OriginalsSDK.create({ authors: [] }).load(new Uint8Array(await exported.arrayBuffer()))).report;
  expect(report.original).toBe(a.did);
  expect(report.authorBinding.status).toBe('valid');
  expect(report.resources.status).toBe('available');
});

test('hosted Originals without summaries are discovered and reopened without enabling public Explore (C12-01, P7.5)', async () => {
  const { DemoEngine } = await import('../../src/sdk/engine');
  const { host, DOMAIN, SUB } = await import('../../src/sdk/publish.fixture');
  const { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } = await import('../../src/auth/webvh');
  const ed = await import('@noble/ed25519');
  const h = host();
  const key = ed.utils.randomSecretKey();
  const signer = new BrowserWebVHSigner(key, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(key)));
  const engine = new DemoEngine({ features: { hostedPublication: true }, publishTarget: { upload: h.upload, read: h.read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => signer } });
  await engine.create('Hosted recovery', 'Orbits', 'exact hosted bytes');
  const published = await engine.publish();
  const stored = createOriginalsStore({ dataDir: h.dataDir });
  expect(stored.list(SUB)).toEqual([]); // no separately recorded summary
  const library = createAnchoringLibrary(h.dataDir, stored);
  expect(await library.list(SUB)).toMatchObject([{ did: published.did, availability: 'server', title: 'Hosted recovery' }]);
  expect(await library.list('another-account')).toEqual([]);
  expect(await library.evidence('another-account', published.did)).toBeNull();
  const fresh = new DemoEngine();
  const recovered = await fresh.importEvidence((await library.evidence(SUB, published.did))!, published.did);
  expect(recovered.history).toEqual(published.history);
  expect(recovered.resource).toEqual(published.resource);
  expect(recovered.author).toBe(published.author);
});

test('evidence with two histories, neither chosen, answers 409 diverged rather than a 404 (#996 review; P6.6)', async () => {
  const { OriginalsError } = await import('@originals/vh');
  const dataDir = await mkdtemp(join(tmpdir(), 'originals-library-routes-'));
  const library = {
    list: async () => [],
    evidence: async (): Promise<Uint8Array | null> => { throw new OriginalsError('fork', 'EVIDENCE_DIVERGED', 'Two copies disagree.'); },
  };
  const routes = createOriginalsRoutes({ jwtSecret: secret, store: createOriginalsStore({ dataDir }), library });
  const answer = await routes.evidence(request('alice'), new URL('http://landing.test/api/originals/evidence?did=did:vh:x'));
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: 'diverged', message: 'Two copies disagree.' });
});
