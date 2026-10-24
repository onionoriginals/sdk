import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryStore, type OriginalsStore } from '@originals/sdk/originals';
import { IndexedDbStore, storeName } from './idb-store';

// #976 B, gap G2. The signed-in browser keeps an author's work in IndexedDB,
// so it survives a browser restart. It keeps the same contract as the SDK's
// MemoryStore and FileStore (P6.2, P6.4, P6.8, P7.8), proven here side by side.
const DID = 'did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';
const line = (v: string) => `{"versionId":"${v}"}\n`;
const refused = (n: number, extra: Partial<{ reconciledAs: string }> = {}) => ({ label: 'refused' as const, parent: '1-a', entry: `{"versionId":"2-${n}"}`, hostHead: '2-host', ...extra });

const kinds: Array<[string, () => Promise<OriginalsStore>]> = [
  ['MemoryStore', async () => new MemoryStore()],
  ['IndexedDbStore', async () => IndexedDbStore.open('suborg-contract', new IDBFactory())],
];

for (const [kind, make] of kinds) {
  describe(`${kind}: the local store contract`, () => {
    test('commit is conditional on the head it builds on (P6.2)', async () => {
      const store = await make();
      await store.commit(DID, { expectedHead: null, log: line('1-a') });
      await expect(store.commit(DID, { expectedHead: null, log: line('1-b') })).rejects.toMatchObject({ category: 'stale-parent' });
      await store.commit(DID, { expectedHead: '1-a', log: line('1-a') + line('2-b') });
      await expect(store.commit(DID, { expectedHead: '1-a', log: line('1-a') + line('2-c') })).rejects.toMatchObject({ category: 'stale-parent' });
      expect((await store.get(DID))?.log).toBe(line('1-a') + line('2-b'));
      expect(await store.list()).toEqual([DID]);
      expect(await store.get('did:vh:other')).toBeUndefined();
    });

    test('resources are content addressed: the first bytes stay, and reads are copies', async () => {
      const store = await make();
      const bytes = new Uint8Array([1, 2, 3]);
      await store.putResource('d1', bytes);
      bytes[0] = 9;
      await store.putResource('d1', new Uint8Array([7]));
      const read = (await store.getResource('d1'))!;
      expect([...read]).toEqual([1, 2, 3]);
      read[0] = 5;
      expect([...(await store.getResource('d1'))!]).toEqual([1, 2, 3]);
      expect(await store.getResource('missing')).toBeUndefined();
    });

    test('author evidence round-trips; retained versionIds never go down (P7.8)', async () => {
      const store = await make();
      await store.putAuthorEvidence({ did: 'did:webvh:x', log: line('1-a') });
      expect(await store.getAuthorEvidence('did:webvh:x')).toEqual({ did: 'did:webvh:x', log: line('1-a') });
      await store.putRetained(DID, '3-c');
      await store.putRetained(DID, '2-b');
      expect(await store.getRetained(DID)).toBe('3-c');
    });

    test('branches are kept once each (P6.6)', async () => {
      const store = await make();
      await store.putBranch(DID, 'a');
      await store.putBranch(DID, 'a');
      await store.putBranch(DID, 'b');
      expect(await store.getBranches(DID)).toEqual(['a', 'b']);
    });

    test('C12-125: refused candidates are kept beside the log; a relabel never changes the entry (P6.8)', async () => {
      const store = await make();
      await store.putRefused(DID, refused(1));
      await store.putRefused(DID, refused(1));
      await store.putRefused(DID, refused(2));
      await store.putRefused(DID, refused(1, { reconciledAs: '3-x' }));
      await store.putRefused(DID, { ...refused(2), entry: '{"versionId":"2-2","other":1}' });
      const kept = await store.getRefused(DID);
      expect(kept.map((r) => r.entry)).toEqual([refused(1).entry, refused(2).entry]);
      expect(kept[0].reconciledAs).toBe('3-x');
      await store.dropRefused(DID, '2-1');
      expect((await store.getRefused(DID)).map((r) => r.entry)).toEqual([refused(2).entry]);
    });

    test('C12-128: a pending candidate is kept until the host answers (P6.4)', async () => {
      const store = await make();
      await store.putPending(DID, { parent: '1-a', entry: '{"versionId":"2-p"}' });
      expect(await store.getPending(DID)).toEqual({ parent: '1-a', entry: '{"versionId":"2-p"}' });
      await store.putPending(DID, null);
      expect(await store.getPending(DID)).toBeUndefined();
    });
  });
}

describe('IndexedDbStore: durable across a browser restart', () => {
  test('a second handle on the same database sees everything the first wrote', async () => {
    const idb = new IDBFactory();
    const first = await IndexedDbStore.open('suborg-a', idb);
    await first.commit(DID, { expectedHead: null, log: line('1-a') });
    await first.putResource('d1', new Uint8Array([1]));
    await first.putPending(DID, { parent: '1-a', entry: '{"versionId":"2-p"}' });
    first.close();
    const second = await IndexedDbStore.open('suborg-a', idb);
    expect((await second.get(DID))?.log).toBe(line('1-a'));
    expect([...(await second.getResource('d1'))!]).toEqual([1]);
    expect((await second.getPending(DID))?.entry).toBe('{"versionId":"2-p"}');
  });

  test('each account has its own database', async () => {
    const idb = new IDBFactory();
    const a = await IndexedDbStore.open('suborg-a', idb);
    await a.commit(DID, { expectedHead: null, log: line('1-a') });
    const b = await IndexedDbStore.open('suborg-b', idb);
    expect(await b.list()).toEqual([]);
    expect(storeName('suborg-a')).not.toBe(storeName('suborg-b'));
  });

  test('two tabs committing on the same parent: exactly one wins, none is lost', async () => {
    const idb = new IDBFactory();
    const a = await IndexedDbStore.open('suborg-a', idb);
    const b = await IndexedDbStore.open('suborg-a', idb);
    await a.commit(DID, { expectedHead: null, log: line('1-a') });
    const results = await Promise.allSettled([
      a.commit(DID, { expectedHead: '1-a', log: line('1-a') + line('2-a') }),
      b.commit(DID, { expectedHead: '1-a', log: line('1-a') + line('2-b') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const head = (await a.get(DID))!.log;
    expect([line('1-a') + line('2-a'), line('1-a') + line('2-b')]).toContain(head);
  });
});

const rawOpen = (idb: IDBFactory, version: number, tables: string[], onblocked?: () => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(storeName('suborg-a'), version);
    r.onupgradeneeded = () => {
      for (const name of tables) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
    };
    r.onblocked = () => onblocked?.();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
// The version 1 schema, as #976 G2 first shipped it.
const V1_TABLES = ['originals', 'resources', 'authors', 'retained', 'branches', 'refused', 'pending'];

// C12-99, P9.16: the anchor last reported for an anchored Original is kept, so
// after a browser restart a changed anchor is still reported, never silent.
describe('IndexedDbStore: retained anchors survive a restart', () => {
  const anchor = { inscription: 'abc0i0', sat: '1234', owner: 'txid:0' };

  test('a retained anchor round-trips across handles', async () => {
    const idb = new IDBFactory();
    const first = await IndexedDbStore.open('suborg-a', idb);
    expect(await first.getRetainedAnchor(DID)).toBeUndefined();
    await first.putRetainedAnchor(DID, anchor);
    first.close();
    const second = await IndexedDbStore.open('suborg-a', idb);
    expect(await second.getRetainedAnchor(DID)).toEqual(anchor);
    await second.putRetainedAnchor(DID, { ...anchor, owner: null });
    expect(await second.getRetainedAnchor(DID)).toEqual({ ...anchor, owner: null });
  });

  test('a version 1 database upgrades by adding the table, keeping every Original', async () => {
    const idb = new IDBFactory();
    const v1 = await rawOpen(idb, 1, V1_TABLES);
    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction('originals', 'readwrite');
      tx.objectStore('originals').put({ log: line('1-a') }, DID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v1.close();
    const upgraded = await IndexedDbStore.open('suborg-a', idb);
    expect((await upgraded.get(DID))?.log).toBe(line('1-a'));
    await upgraded.putRetainedAnchor(DID, anchor);
    expect(await upgraded.getRetainedAnchor(DID)).toEqual(anchor);
  });

  test('the SDK sees the optional methods, so it retains anchors', async () => {
    const store: OriginalsStore = await IndexedDbStore.open('suborg-a', new IDBFactory());
    expect(typeof store.getRetainedAnchor).toBe('function');
    expect(typeof store.putRetainedAnchor).toBe('function');
  });
});

describe('IndexedDbStore: opening is robust to other tabs', () => {
  test('an open connection gives way to an upgrade in another tab, then says why it stopped', async () => {
    const idb = new IDBFactory();
    const store = await IndexedDbStore.open('suborg-a', idb);
    let blocked = false;
    const newer = await rawOpen(idb, 99, [], () => (blocked = true));
    expect(blocked).toBe(false);
    newer.close();
    await expect(store.get(DID)).rejects.toThrow(/another tab/i);
  });

  test('a blocked open waits for the other tab instead of failing', async () => {
    const idb = new IDBFactory();
    // An old tab holding version 1, with no versionchange handler.
    const old = await rawOpen(idb, 1, V1_TABLES);
    const opening = IndexedDbStore.open('suborg-a', idb);
    let settled = false;
    void opening.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    old.close();
    const store = await opening;
    expect(await store.list()).toEqual([]);
  });

  test('without IndexedDB, opening fails by name', async () => {
    await expect(IndexedDbStore.open('suborg-a', undefined as unknown as IDBFactory)).rejects.toThrow(/IndexedDB/);
  });
});
