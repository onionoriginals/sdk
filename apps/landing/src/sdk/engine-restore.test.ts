import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK, type HostedFetch } from '@originals/sdk/originals';
import { AccountIndexError, DemoEngine } from './engine';
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
  const client = (a: LocalAuthor = author, o: { read?: HostedFetch; idb?: IDBFactory } = {}) => {
    const idb = o.idb ?? new IDBFactory();
    return new DemoEngine({
      authed: true,
      subOrgId: SUB,
      features: { hostedPublication: true },
      openStore: () => IndexedDbStore.open(SUB, idb),
      author: async () => a,
      publishTarget: { upload, read: o.read ?? read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
  };
  return { client, read, author };
}

/** A reader that runs `before` ahead of its `n`th read of an alias log (`…/o-…/did.jsonl`), once. */
function onAliasRead(read: HostedFetch, n: number, before: () => Promise<void>): HostedFetch {
  let seen = 0;
  return async (url, o) => {
    if (/\/o-[^/]+\/did\.jsonl$/.test(url) && ++seen === n) await before();
    return read(url, o);
  };
}

// G5: completion depends only on the stranger's read-back. The account index
// (G3) is a list for the author's other clients, recorded as its own step,
// retried, and reported on its own (section 7: reports stay separate).
describe('a failed account-index write never blocks publication', () => {
  async function indexFails(status = 507) {
    const author = await createLocalAuthor();
    const { upload, read } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    let failing = true;
    let attempts = 0;
    const flaky = {
      put: upload.put.bind(upload),
      submit: upload.submit.bind(upload),
      listOriginals: upload.listOriginals.bind(upload),
      recordOriginal: (entry: Parameters<typeof upload.recordOriginal>[0]) => {
        attempts++;
        return failing ? Promise.reject(new Error(`DurableHostingStorageAdapter.recordOriginal failed: ${status}`)) : upload.recordOriginal(entry);
      },
    };
    const idb = new IDBFactory();
    const client = (u: typeof flaky | typeof upload = flaky, store = idb) =>
      new DemoEngine({
        authed: true,
        subOrgId: SUB,
        features: { hostedPublication: true },
        openStore: () => IndexedDbStore.open(SUB, store),
        author: async () => author,
        publishTarget: { upload: u, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
      });
    return { client, read, heal: () => (failing = false), attempts: () => attempts };
  }

  test('a 507 STORE_FULL from the index: publication is still complete, editable, and the index is reported unlisted', async () => {
    const w = await indexFails(507);
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    expect(published.publication).toBe('complete');
    expect(published.layer).toBe('did:webvh');
    expect(published.accountIndex).toBe('not-listed');
    const r = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(published.webvhDid!, w.read);
    expect(r.verified).toBe(true);
    // Editing goes on, through the host.
    const revised = await a.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));
    expect(revised.publication).toBe('complete');

    // Retrying while the index still refuses says why, in the page's words.
    const { demoFailureMessage } = await import('../components/demo-logic');
    const { demo } = await import('../content');
    const refused = await a.retryAccountIndex().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AccountIndexError);
    expect(demoFailureMessage(refused)).toBe(demo.hosting.indexFull);
    expect(demoFailureMessage(new AccountIndexError(500, 'x'))).toBe(demo.hosting.indexUnavailable);

    w.heal();
    expect((await a.retryAccountIndex()).accountIndex).toBe('listed');
    expect((await w.client(undefined, new IDBFactory()).listOriginals()).map((o) => o.did)).toEqual([published.did]);
  });

  test('after a restart, an unlisted publication is retried when the Original is opened', async () => {
    const w = await indexFails(500);
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    expect(published.accountIndex).toBe('not-listed');
    w.heal();
    const before = w.attempts();
    const reopened = await w.client().open(published.did);
    expect(w.attempts()).toBe(before + 1);
    expect(reopened.accountIndex).toBe('listed');
    expect(reopened.publication).toBe('complete');
  });
});

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

    // C12-125: client A, a revision behind, can't save on its old parent:
    // the host refuses it with a stale-parent conflict, never a rebase (P4.5).
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

describe('restore and the host moving on (P2.1, P4.5)', () => {
  test('C12-128: the host head moves between the sync and the read-back: restore follows the descending head', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    // Restore reads the alias log itself, then the read-back reads it again.
    // Between the two, client A saves on the host.
    let moved: string | undefined;
    const b = w.client(w.author, {
      read: onAliasRead(w.read, 2, async () => {
        moved = (await a.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8))).history.at(-1)!.versionId;
      }),
    });
    const restored = await b.restore(published.did);
    expect(moved).toBeDefined();
    expect(restored.publication).toBe('complete');
    expect(restored.history.at(-1)!.versionId).toBe(moved!);
    expect(restored.history.slice(0, published.history.length).map((h) => h.versionId)).toEqual(published.history.map((h) => h.versionId));
  });

  test('a failed read-back leaves this page as it was, and the restored copy resumable', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    const idb = new IDBFactory();
    let blind = true;
    // Reads fail only once the sync has committed the host's log to B's
    // store: the read-back, not the sync, is what fails.
    const synced = async () => (await (await IndexedDbStore.open(SUB, idb)).list()).includes(published.did);
    const read: HostedFetch = async (url, o) => (blind && (await synced()) ? Promise.reject(new Error('timed out')) : w.read(url, o));
    const b = w.client(w.author, { read, idb });
    await expect(b.restore(published.did)).rejects.toThrow();
    // Nothing in this page claims the Original (item: set only after success).
    expect(() => b.snapshot()).toThrow(/No asset yet/);
    // The copy is in this browser, listed but not complete, and finishing it completes it.
    blind = false;
    const later = w.client(w.author, { read, idb });
    expect((await later.listOriginals()).find((o) => o.did === published.did)?.where).toBe('this-browser');
    const reopened = await later.open(published.did);
    expect(reopened.publication).toBe('incomplete');
    expect((await later.publish()).publication).toBe('complete');
  });
});
