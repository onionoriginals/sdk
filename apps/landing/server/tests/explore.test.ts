import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OriginalsSDK,
  createLocalSigner,
  type StorageAdapter,
} from '@originals/sdk';
import { createOriginalsStore } from '../originals-store';
import { createExploreRoutes } from '../explore';
import { buildFetch } from '../app';
import { createOriginalsRoutes } from '../originals-routes';
import { createWebvhHostStore } from '../webvh-host';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'originals-explore-'));
  dirs.push(dataDir);
  const store = createOriginalsStore({ dataDir });
  async function publish(sub: string, title: string, domain = 'gallery.test') {
    const storageAdapter: StorageAdapter = {
      async putObject(host, path, bytes, options) {
        store.saveBytes(
          sub,
          `${host}/${path}`,
          typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
          options?.contentType ?? 'application/octet-stream',
        );
        return `https://${host}/${path}`;
      },
      async getObject(host, path) {
        const r = store.read(sub, `${host}/${path}`);
        return r.ok
          ? {
              content: new Uint8Array(await r.arrayBuffer()),
              contentType: r.headers.get('content-type') ?? undefined,
            }
          : null;
      },
      async exists(host, path) {
        return store.read(sub, `${host}/${path}`).ok;
      },
    };
    const sdk = OriginalsSDK.create({
      signer: createLocalSigner(
        'Ed25519',
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      storageAdapter,
    });
    const asset = await sdk.lifecycle.createAsset(
      [
        {
          id: 'art.svg',
          mediaType: 'image/svg+xml',
          content:
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>',
        },
      ],
      { name: title },
    );
    const result = await sdk.lifecycle.publishToWeb(asset, { domain });
    store.recordOriginal(sub, {
      did: result.did,
      title: 'UNTRUSTED INDEX TITLE',
      createdAt: '2099-01-01',
      resourceHash: 'untrusted',
      btcoDid: 'did:btco:1',
      inscriptionStatus: 'confirmed',
    });
    return result.did;
  }
  const routes = createExploreRoutes({ store, dataDir });
  const request = (path: string) =>
    routes.handle(
      new Request(`https://gallery.test${path}`),
      new URL(`https://gallery.test${path}`),
      'ip',
    );
  return { store, dataDir, publish, request };
}

describe('public Explore discovery', () => {
  test('the public route is accessible while the account collection remains authenticated', async () => {
    const t = await setup();
    await t.publish('alice', 'Public work');
    const originals = createOriginalsRoutes({
      store: t.store,
      jwtSecret: 'test-only-secret-with-at-least-32-characters',
    });
    const fetch = buildFetch({
      apiRoutes: { 'GET /api/originals': originals.list },
      originals,
      hostStore: createWebvhHostStore(),
      distDir: t.dataDir + '/',
      explore: createExploreRoutes(t),
      trustedProxyHops: 0,
    });
    const result = await fetch(new Request('https://gallery.test/api/explore'));
    expect(result.status).toBe(200);
    expect((await result.json()).total).toBe(1);
    expect(
      (await fetch(new Request('https://gallery.test/api/originals'))).status,
    ).toBe(401);
    const withoutAuth = buildFetch({
      apiRoutes: null,
      publications: t.store,
      hostStore: createWebvhHostStore(),
      distDir: t.dataDir + '/',
      explore: createExploreRoutes(t),
      trustedProxyHops: 0,
    });
    const publicPage = await (
      await withoutAuth(new Request('https://gallery.test/api/explore'))
    ).json();
    expect(publicPage.total).toBe(1);
    expect(
      (
        await withoutAuth(
          new Request(
            'https://gallery.test' + publicPage.originals[0].resourceUrl,
          ),
        )
      ).status,
    ).toBe(200);
  });
  test('rejects a tampered method history even when its CEL signatures remain valid', async () => {
    const t = await setup();
    const did = await t.publish('alice', 'Tampered');
    const key =
      'gallery.test/' +
      did.split(':').slice(4).map(decodeURIComponent).join('/') +
      '/did.jsonl';
    const log = (await t.store.read('alice', key).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    log[0].state.alsoKnownAs = ['did:cel:unrelated'];
    t.store.saveBytes(
      'alice',
      key,
      new TextEncoder().encode(
        log.map((entry) => JSON.stringify(entry)).join('\n'),
      ),
      'application/jsonl',
    );
    expect((await (await t.request('/api/explore')).json()).total).toBe(0);
  });
  test('anonymous readers discover signed publications across accounts without account or unverified Bitcoin fields', async () => {
    const t = await setup();
    await t.publish('alice', 'A field of stars');
    await t.publish('bob', 'Quiet water');
    const response = await t.request('/api/explore');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(
      body.originals.map((o: { title: string }) => o.title).sort(),
    ).toEqual(['A field of stars', 'Quiet water']);
    for (const row of body.originals) {
      expect(row.controller).toStartWith('did:key:');
      expect(row.resourceUrl).toStartWith('/published/');
      expect(row).not.toHaveProperty('subOrgId');
      expect(row).not.toHaveProperty('email');
      expect(row).not.toHaveProperty('btcoDid');
      expect(row).not.toHaveProperty('inscriptionStatus');
      expect(row.createdAt).not.toBe('2099-01-01');
    }
  });
  test('excludes unpublished rows, another host and a copied account claim; a corrupt account does not break discovery', async () => {
    const t = await setup();
    const did = await t.publish('alice', 'Real');
    await t.publish('foreign', 'Foreign', 'another.test');
    t.store.recordOriginal('bob', {
      did,
      title: 'Stolen title',
      resourceHash: 'x',
      createdAt: '2099',
    });
    t.store.recordOriginal('bob', {
      did: 'did:webvh:fake:gallery.test:missing',
      title: 'Draft',
      resourceHash: 'x',
      createdAt: '2099',
    });
    writeFileSync(join(t.dataDir, 'users', 'broken.json'), 'not JSON');
    const body = await (await t.request('/api/explore')).json();
    expect(body.total).toBe(1);
    expect(body.originals[0].title).toBe('Real');
  });
  test('a malformed candidate DID does not hide valid publications from the same account', async () => {
    const t = await setup();
    const did = await t.publish('alice', 'Still discoverable');
    t.store.recordOriginal('alice', {
      did: 'did:webvh:bad:gallery.test:%',
      title: 'Malformed candidate',
      resourceHash: 'x',
      createdAt: '2099',
    });
    const body = await (await t.request('/api/explore')).json();
    expect(body.total).toBe(1);
    expect(body.originals[0].did).toBe(did);
    expect(body.originals[0].title).toBe('Still discoverable');
  });
  test('search, bounded pagination, public detail and missing detail work without a session', async () => {
    const t = await setup();
    const a = await t.publish('alice', 'North');
    await t.publish('bob', 'South');
    const page = await (await t.request('/api/explore?limit=1')).json();
    expect(page.originals).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    const next = await (
      await t.request('/api/explore?limit=1&offset=1')
    ).json();
    expect(next.nextOffset).toBeNull();
    expect(next.originals[0].did).not.toBe(page.originals[0].did);
    const found = await (await t.request('/api/explore?q=NORTH')).json();
    expect(found.total).toBe(1);
    expect(found.originals[0].did).toBe(a);
    expect((await t.request('/api/explore?limit=999')).status).toBe(400);
    expect((await t.request('/api/explore?offset=-1')).status).toBe(400);
    const detail = await (
      await t.request('/api/explore/original?did=' + encodeURIComponent(a))
    ).json();
    expect(detail.original.title).toBe('North');
    expect((await t.request('/api/explore/original?did=missing')).status).toBe(
      404,
    );
  });
});
