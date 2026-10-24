import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK, type HostedFetch } from '@originals/sdk/originals';
import { AccountIndexError, DemoEngine } from './engine';
import { generateArtwork } from './artwork';
import { BrowserOriginalsStore } from './browser-store';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';
import { createLocalAuthor, type LocalAuthor } from './local-author';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';

// #976 B3, gap G3. On another client (a fresh browser profile, an empty
// store), the signed-in author finds a published Original in the account's
// library (main's /me data path: GET /api/originals and its evidence) and
// restores it, then reads the host, verified as any reader verifies it,
// then keeps editing from the host's head as the explicit parent (P2.1, P6.7).
// The authority to sign is the author's own key, never the index or the host.
const art = (title: string, seed: number) => generateArtwork(title, 'Orbits', seed).svg;

async function world() {
  const author = await createLocalAuthor();
  const { upload, read, fetchAs } = host();
  const secret = ed.utils.randomSecretKey();
  const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
  const client = (a: LocalAuthor = author, o: { read?: HostedFetch; idb?: IDBFactory; noEvidence?: boolean } = {}) => {
    const idb = o.idb ?? new IDBFactory();
    return new DemoEngine({
      authed: true,
      subOrgId: SUB,
      features: { hostedPublication: true },
      store: new BrowserOriginalsStore(SUB, idb),
      author: async () => a,
      publishTarget: {
        // noEvidence: the account's evidence route has nothing for it, so restore syncs from the host alone.
        upload: o.noEvidence ? Object.assign(Object.create(upload), { evidence: async () => null }) : upload,
        read: o.read ?? read,
        domain: DOMAIN,
        slug: userWebvhSlug(SUB),
        aliasSigner: async () => aliasSigner,
      },
    });
  };
  return { client, read, author, rows: () => accountRows(fetchAs) };
}

/** The account's library rows, as /me reads them (GET /api/originals). */
async function accountRows(fetchAs: ReturnType<typeof host>['fetchAs']) {
  const res = await fetchAs(SUB)('http://app.local/api/originals');
  return ((await res.json()) as { originals: Array<{ did: string; title: string; availability: string; alias?: string }> }).originals;
}

// G5: completion depends only on the stranger's read-back. The account index
// (G3) is a list for the author's other clients, recorded as its own step,
// retried, and reported on its own (section 7: reports stay separate).
describe('a failed account-index write never blocks publication', () => {
  async function indexFails(status = 507) {
    const author = await createLocalAuthor();
    const { upload, read, fetchAs } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    let failing = true;
    let attempts = 0;
    const flaky = {
      put: upload.put.bind(upload),
      submit: upload.submit.bind(upload),
      evidence: upload.evidence.bind(upload),
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
        store: new BrowserOriginalsStore(SUB, store),
        author: async () => author,
        publishTarget: { upload: u, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
      });
    return { client, read, heal: () => (failing = false), attempts: () => attempts, rows: () => accountRows(fetchAs) };
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

    // main's library already finds the hosted snapshot; the index adds its alias.
    expect((await w.rows()).find((o) => o.did === published.did)?.alias).toBeUndefined();
    w.heal();
    expect((await a.retryAccountIndex()).accountIndex).toBe('listed');
    expect((await w.rows()).find((o) => o.did === published.did)?.alias).toBe(published.webvhDid);
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
  test('listed in the account library, restored, and edited from the host\'s head', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    // Client A only: an unpublished Original stays in A's own store.
    const draft = await a.create('Sketch', 'Orbits', art('Sketch', 2));

    const idbB = new IDBFactory();
    const b = w.client(w.author, { idb: idbB });
    const listed = await w.rows();
    expect(listed.find((o) => o.did === published.did)).toMatchObject({ title: 'Harbor at dawn', availability: 'server', alias: published.webvhDid });
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

    // After restoring, B's own store holds it.
    expect(await new BrowserOriginalsStore(SUB, idbB).list()).toEqual([published.did]);

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
    await expect(w.client().restore('did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ')).rejects.toThrow(/isn't saved to this account/);
  });
});

// #996: a fork that stands, or an account whose saved copies diverge (409
// diverged), is reported and nothing is chosen (S1, P6.6). Restore on open
// must not reach past either to the host's head.
describe('restore stops at a fork or a divergence (S1, P6.6, C12-23)', () => {
  test('a 409 diverged from the account: restore stops with that message, before any host read', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    let reads = 0;
    const read: HostedFetch = (url, o) => (reads++, w.read(url, o));
    const idb = new IDBFactory();
    const b = w.client(w.author, { idb, read });
    const { library } = await import('../content');
    // The account's evidence route answers 409 diverged (server/originals-library.ts).
    const target = (b as unknown as { target: { upload: { evidence: (did: string) => Promise<Uint8Array | null> } } }).target;
    target.upload = Object.assign(Object.create(target.upload), {
      evidence: () => new DurableHostingStorageAdapter({ baseUrl: 'http://x', fetchImpl: (async () => new Response(JSON.stringify({ error: 'diverged' }), { status: 409 })) as unknown as typeof fetch }).evidence(published.did),
    });
    await expect(b.restore(published.did)).rejects.toThrow(library.diverged);
    expect(reads).toBe(0);
    expect(await new BrowserOriginalsStore(SUB, idb).getPublication(published.did)).toBeUndefined();
  });

  test('a fork that stands in this browser: restore opens it as it is, and never syncs or reads back', async () => {
    const w = await world();
    const idbA = new IDBFactory();
    const a = w.client(w.author, { idb: idbA });
    const created = await a.create('Shared', 'Orbits', art('Shared', 1));
    const published = await a.publish();
    // Another device extends the published copy differently, offline from the host.
    const sdkB = OriginalsSDK.create({ store: new MemoryStore(), authors: [w.author.evidence] });
    await sdkB.import(await a.evidencePackage());
    await sdkB.edit(created.did, { parent: published.history.at(-1)!.versionId, name: 'Elsewhere', author: w.author.ref, signer: w.author.signer });
    await a.update('Here', 'Orbits', art('Here', 3));
    await expect(a.importEvidence((await sdkB.package(created.did)).bytes, created.did)).rejects.toThrow(/conflict/i);
    let reads = 0;
    const read: HostedFetch = (url, o) => (reads++, w.read(url, o));
    const reopening = w.client(w.author, { idb: idbA, read, noEvidence: true });
    const state = await reopening.restore(published.did);
    expect(reads).toBe(0);
    expect((state.provenance as { fork?: unknown }).fork).toBeDefined();
  });
});

describe('restore and the host moving on (P2.1, P4.5)', () => {
  test('a failed read-back on reopen never downgrades a complete publication', async () => {
    const w = await world();
    const idbA = new IDBFactory();
    const a = w.client(w.author, { idb: idbA });
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    expect(published.publication).toBe('complete');
    // Another client moves the host on, so A's reopen has to sync and read back.
    const b = w.client(w.author);
    await b.restore(published.did);
    await b.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8));
    // A reopens /me/<did>. The sync's retrieval is the first manifest read;
    // the read-back's is the second, and it fails (a transient 5xx).
    let manifests = 0;
    const read: HostedFetch = async (url, o) => (/originals-evidence\.json$/.test(url) && ++manifests >= 2 ? Promise.reject(new Error('503 from the host')) : w.read(url, o));
    const reopening = w.client(w.author, { idb: idbA, read, noEvidence: true });
    await expect(reopening.restore(published.did)).rejects.toThrow();
    expect((await new BrowserOriginalsStore(SUB, idbA).getPublication(published.did))?.state).toBe('complete');
    // Still published, and still editable, through the host.
    const later = w.client(w.author, { idb: idbA });
    const reopened = await later.open(published.did);
    expect(reopened.publication).toBe('complete');
    const next = await later.update('Harbor at night', 'Orbits', art('Harbor at night', 9));
    expect(next.publication).toBe('complete');
  });

  test('a reopen whose record is complete and whose host is already current skips the read-back', async () => {
    const w = await world();
    const idbA = new IDBFactory();
    const a = w.client(w.author, { idb: idbA });
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    // One retrieval is the sync's; a read-back would be a second.
    let manifests = 0;
    const read: HostedFetch = (url, o) => ((/originals-evidence\.json$/.test(url) && manifests++), w.read(url, o));
    const reopened = await w.client(w.author, { idb: idbA, read }).restore(published.did);
    expect(reopened.publication).toBe('complete');
    expect(manifests).toBe(1);
  });

  test('C12-128: the host head moves between the sync and the read-back: restore follows the descending head', async () => {
    const w = await world();
    const a = w.client();
    await a.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    const published = await a.publish();
    // Once the sync has stored the alias evidence in B, and before B's
    // read-back, client A saves on the host.
    let moved: string | undefined;
    const idb = new IDBFactory();
    const read: HostedFetch = async (url, o) => {
      if (!moved && (await new BrowserOriginalsStore(SUB, idb).getAuthorEvidence(published.webvhDid!))) {
        moved = (await a.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8))).history.at(-1)!.versionId;
      }
      return w.read(url, o);
    };
    const b = w.client(w.author, { read, idb });
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
    // Fail reads once B holds the alias evidence: after the sync, so the read-back fails.
    const synced = async () => !!(await new BrowserOriginalsStore(SUB, idb).getAuthorEvidence(published.webvhDid!));
    const read: HostedFetch = async (url, o) => (blind && (await synced()) ? Promise.reject(new Error('timed out')) : w.read(url, o));
    const b = w.client(w.author, { read, idb });
    await expect(b.restore(published.did)).rejects.toThrow();
    // Nothing in this page claims the Original (item: set only after success).
    expect(() => b.snapshot()).toThrow(/No asset yet/);
    // The copy is in this browser, listed but not complete, and finishing it completes it.
    blind = false;
    const later = w.client(w.author, { read, idb });
    expect(await new BrowserOriginalsStore(SUB, idb).list()).toContain(published.did);
    expect((await new BrowserOriginalsStore(SUB, idb).getPublication(published.did))?.state).toBe('uploaded');
    const reopened = await later.open(published.did);
    expect(reopened.publication).toBe('incomplete');
    expect((await later.publish()).publication).toBe('complete');
  });
});
