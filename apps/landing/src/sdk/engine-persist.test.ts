import { afterEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { DemoEngine } from './engine';
import { generateArtwork } from './artwork';
import { BrowserOriginalsStore, browserDatabase } from './browser-store';
import { createLocalAuthor, type LocalAuthor } from './local-author';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';

// #976 B3, gap G2. A signed-in author's work is kept in IndexedDB
// (BrowserOriginalsStore, the account's database), so closing
// the browser and opening it again finds it, and editing continues from the
// explicit parent (P2.1, P4.5). The signing authority is the author's own
// (Turnkey in the app; a test key here), never something the store holds.
function signedIn(idb: IDBFactory, author: LocalAuthor, extra: ConstructorParameters<typeof DemoEngine>[0] = {}) {
  return new DemoEngine({
    authed: true,
    subOrgId: SUB,
    store: new BrowserOriginalsStore(SUB, idb),
    author: async () => author,
    ...extra,
  });
}

const art = (title: string, seed: number) => generateArtwork(title, 'Orbits', seed).svg;

describe('a signed-in author\'s work survives a browser restart', () => {
  test('the Original is in the account store, reopens at its checkpoint and takes the next revision', async () => {
    const idb = new IDBFactory();
    const author = await createLocalAuthor();
    const before = signedIn(idb, author);
    await before.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const revised = await before.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));

    const after = signedIn(idb, author);
    expect(await new BrowserOriginalsStore(SUB, idb).list()).toEqual([revised.did]);
    const reopened = await after.open(revised.did);
    expect(reopened.history.map((h) => h.versionId)).toEqual(revised.history.map((h) => h.versionId));
    expect(reopened.resource.hash).toBe(revised.resource.hash);

    const next = await after.update('Harbor at night', 'Orbits', art('Harbor at night', 9));
    expect(next.did).toBe(revised.did);
    expect(next.history.length).toBe(revised.history.length + 1);
    expect(next.history.slice(0, -1).map((h) => h.versionId)).toEqual(revised.history.map((h) => h.versionId));
  });

  test('a published Original reopens published: its revisions still go through the host (P6.7)', async () => {
    const idb = new IDBFactory();
    const author = await createLocalAuthor();
    const { upload, read } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    const target = { upload, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner };
    const before = signedIn(idb, author, { features: { hostedPublication: true }, publishTarget: target });
    await before.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await before.publish();

    const after = signedIn(idb, author, { features: { hostedPublication: true }, publishTarget: target });
    const reopened = await after.open(published.did);
    expect(reopened.webvhDid).toBe(published.webvhDid);
    const revised = await after.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const r = await stranger.loadPublished(published.webvhDid!, read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(revised.history.at(-1)!.versionId);
  });

  test('another author\'s key can\'t continue the work just because the store holds it', async () => {
    const idb = new IDBFactory();
    const before = signedIn(idb, await createLocalAuthor());
    const created = await before.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const intruder = signedIn(idb, await createLocalAuthor());
    await expect(intruder.open(created.did).then(() => intruder.update('Mine now', 'Orbits', art('Mine now', 3)))).rejects.toThrow();
  });
});

describe('without IndexedDB (#976 B, G2)', () => {
  const saved = globalThis.indexedDB;
  afterEach(() => {
    globalThis.indexedDB = saved;
  });

  for (const authed of [true, false]) {
    test(`${authed ? 'signed in' : 'signed out'}, the work is kept in memory and the snapshot says so`, async () => {
      globalThis.indexedDB = undefined as unknown as IDBFactory;
      const engine = new DemoEngine({ authed, ...(authed ? { subOrgId: SUB, author: await createLocalAuthor() } : {}) });
      const created = await engine.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
      expect(created.notKeptAcrossRestarts).toBe(true);
    });
  }

  test('with IndexedDB, there is no such notice', async () => {
    const created = await signedIn(new IDBFactory(), await createLocalAuthor()).create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    expect(created.notKeptAcrossRestarts).toBeUndefined();
  });
});

// #976 B5; owner decision of 23 October 2026 (#992). Signed out, the guest key
// and the guest's work are kept in this browser's guest database, and nowhere
// else: not in an account's database.
describe('signed out, guest work stays in the guest database', () => {
  const saved = globalThis.indexedDB;
  afterEach(() => {
    globalThis.indexedDB = saved;
  });

  test('a reload finds the guest work under the same guest key; no account database is written', async () => {
    const idb = new IDBFactory();
    globalThis.indexedDB = idb;
    const created = await new DemoEngine().create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    expect((await idb.databases()).map((d) => d.name)).toEqual([browserDatabase()]);
    // The reload: a new engine on the same browser.
    const reloaded = new DemoEngine();
    const reopened = await reloaded.open(created.did);
    expect(reopened.history.map((h) => h.versionId)).toEqual(created.history.map((h) => h.versionId));
    const next = await reloaded.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));
    expect(next.author).toBe(created.author);
    expect((await idb.databases()).map((d) => d.name)).toEqual([browserDatabase()]);
  });
});
