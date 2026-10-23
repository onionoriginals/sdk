import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { DemoEngine } from './engine';
import { generateArtwork } from './artwork';
import { IndexedDbStore } from './idb-store';
import { createLocalAuthor, type LocalAuthor } from './local-author';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';

// #976 B3, gap G3. On another client (a fresh browser profile, an empty
// store), the signed-in author finds a published Original in the account's
// index and restores it from the host, verified as any reader verifies it,
// then keeps editing from the host's head as the explicit parent (P2.1, P6.7).
// The authority to sign is the author's own key, never the index or the host.
const art = (title: string, seed: number) => generateArtwork(title, 'Orbits', seed).svg;

async function world() {
  const author = await createLocalAuthor();
  const { upload, read } = host();
  const secret = ed.utils.randomSecretKey();
  const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
  const client = (a: LocalAuthor = author) => {
    const idb = new IDBFactory();
    return new DemoEngine({
      authed: true,
      subOrgId: SUB,
      features: { hostedPublication: true },
      openStore: () => IndexedDbStore.open(SUB, idb),
      author: async () => a,
      publishTarget: { upload, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
  };
  return { client, read, author };
}

describe('restoring a published Original on another client', () => {
  test('listed from the account, restored from the host, and edited from its head', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    // Client A only: an unpublished Original stays in A's own store.
    const draft = await a.create('Sketch', 'Orbits', art('Sketch', 2));

    const b = w.client();
    const listed = await b.listOriginals();
    expect(listed).toEqual([{ did: published.did, name: 'Harbor at dawn', checkpoint: null, published: true, where: 'host' }]);
    expect(listed.some((o) => o.did === draft.did)).toBe(false);

    const restored = await b.restore(published.did);
    expect(restored.publication).toBe('complete');
    expect(restored.webvhDid).toBe(published.webvhDid);
    expect(restored.history.map((h) => h.versionId)).toEqual(published.history.map((h) => h.versionId));

    const revised = await b.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));
    expect(revised.history.length).toBe(published.history.length + 1);
    const r = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(published.webvhDid!, w.read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(revised.history.at(-1)!.versionId);

    // After restoring, B lists it from its own store too.
    expect((await w.client().listOriginals()).length).toBe(1);
    expect((await b.listOriginals())).toMatchObject([{ did: published.did, where: 'this-browser', published: true }]);

    // Client A, a revision behind, can't save on its old parent: that's a conflict, never a rebase (P4.5).
    await a.open(published.did);
    await expect(a.update('Harbor at noon', 'Orbits', art('Harbor at noon', 4))).rejects.toThrow(/saved this Original first/);
  });

  test('restoring gives no authority: another key can\'t continue it', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    const stranger = w.client(await createLocalAuthor());
    await expect(stranger.restore(published.did).then(() => stranger.update('Mine', 'Orbits', art('Mine', 1)))).rejects.toThrow();
  });

  test('an Original the account never published can\'t be restored', async () => {
    const w = await world();
    await expect(w.client().restore('did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ')).rejects.toThrow(/not published from this account/);
  });
});
