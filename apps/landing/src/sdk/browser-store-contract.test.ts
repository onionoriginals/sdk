import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryStore, type OriginalsStore } from '@originals/sdk/originals';
import { BrowserOriginalsStore, browserDatabase } from './browser-store';

// #976 B, gap G2. The browser keeps an author's work in IndexedDB (signed in,
// the account's database; signed out, the guest's), so it survives a browser
// restart. BrowserOriginalsStore keeps the same contract as the SDK's
// MemoryStore (P6.4, P6.8, P7.8), proven here side by side. Head
// compare-and-swap and account isolation (P6.2, P7.5) are in
// browser-store.test.ts.
const DID = 'did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';
const line = (v: string) => `{"versionId":"${v}"}\n`;
const refused = (n: number, extra: Partial<{ reconciledAs: string }> = {}) => ({ label: 'refused' as const, parent: '1-a', entry: `{"versionId":"2-${n}"}`, hostHead: '2-host', ...extra });

const kinds: Array<[string, () => OriginalsStore]> = [
  ['MemoryStore', () => new MemoryStore()],
  ['BrowserOriginalsStore', () => new BrowserOriginalsStore('suborg-contract', new IDBFactory())],
];

for (const [kind, make] of kinds) {
  describe(`${kind}: the local store contract`, () => {
    test('resources are content addressed: the first bytes stay, and reads are copies', async () => {
      const store = make();
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
      const store = make();
      await store.putAuthorEvidence({ did: 'did:webvh:x', log: line('1-a') });
      expect(await store.getAuthorEvidence('did:webvh:x')).toEqual({ did: 'did:webvh:x', log: line('1-a') });
      await store.putRetained(DID, '3-c');
      await store.putRetained(DID, '2-b');
      expect(await store.getRetained(DID)).toBe('3-c');
    });

    test('branches are kept once each (P6.6)', async () => {
      const store = make();
      await store.putBranch(DID, 'a');
      await store.putBranch(DID, 'a');
      await store.putBranch(DID, 'b');
      expect(await store.getBranches(DID)).toEqual(['a', 'b']);
    });

    test('C12-125: refused candidates are kept beside the log; a relabel never changes the entry (P6.8)', async () => {
      const store = make();
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
      const store = make();
      await store.putPending(DID, { parent: '1-a', entry: '{"versionId":"2-p"}' });
      expect(await store.getPending(DID)).toEqual({ parent: '1-a', entry: '{"versionId":"2-p"}' });
      await store.putPending(DID, null);
      expect(await store.getPending(DID)).toBeUndefined();
    });

    // C12-99, P9.16: the anchor last reported is kept, so a changed anchor is reported, never silent.
    test('C12-99: a retained anchor round-trips', async () => {
      const store = make();
      const anchor = { inscription: 'abc0i0', sat: '1234', owner: 'txid:0' };
      expect(await store.getRetainedAnchor!(DID)).toBeUndefined();
      await store.putRetainedAnchor!(DID, anchor);
      expect(await store.getRetainedAnchor!(DID)).toEqual(anchor);
    });
  });
}

describe('BrowserOriginalsStore: durable across a browser restart', () => {
  test('a second handle on the same database sees everything the first wrote, retained anchor included (P9.16)', async () => {
    const idb = new IDBFactory();
    const first = new BrowserOriginalsStore('suborg-a', idb);
    await first.commit(DID, { expectedHead: null, log: line('1-a') });
    await first.putResource('d1', new Uint8Array([1]));
    await first.putPending(DID, { parent: '1-a', entry: '{"versionId":"2-p"}' });
    await first.putRetainedAnchor(DID, { inscription: 'abc0i0', sat: '1', owner: null });
    const second = new BrowserOriginalsStore('suborg-a', idb);
    expect((await second.get(DID))?.log).toBe(line('1-a'));
    expect([...(await second.getResource('d1'))!]).toEqual([1]);
    expect((await second.getPending(DID))?.entry).toBe('{"versionId":"2-p"}');
    expect(await second.getRetainedAnchor(DID)).toEqual({ inscription: 'abc0i0', sat: '1', owner: null });
  });
});

const rawOpen = (idb: IDBFactory, version: number, onblocked?: () => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(browserDatabase('suborg-a'), version);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('data')) r.result.createObjectStore('data');
    };
    r.onblocked = () => onblocked?.();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

describe('BrowserOriginalsStore: opening is robust to other tabs', () => {
  // The store opens per call, so a connection never outlives its transaction.
  // These drive the two handlers directly: fake-indexeddb can't reorder a real
  // second tab into the middle of one short transaction.
  const watched = (idb: IDBFactory, onRequest: (r: IDBOpenDBRequest) => void) =>
    new Proxy(idb, {
      get(target, key) {
        if (key === 'open') return (name: string, version?: number) => {
          const r = target.open(name, version);
          onRequest(r);
          return r;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as IDBFactory;

  test('a connection closes when another tab upgrades the schema, so the upgrade is never blocked', async () => {
    let request: IDBOpenDBRequest | undefined;
    const store = new BrowserOriginalsStore('suborg-a', watched(new IDBFactory(), (r) => (request = r)));
    await store.list();
    expect(typeof request!.result.onversionchange).toBe('function');
  });

  test('a blocked open is not fatal: it proceeds when the other tab lets go', async () => {
    // An older tab blocks the open: the request reports `blocked`, then succeeds.
    const store = new BrowserOriginalsStore('suborg-a', watched(new IDBFactory(), (r) => {
      queueMicrotask(() => r.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
    }));
    await store.commit(DID, { expectedHead: null, log: line('1-a') });
    expect(await store.list()).toEqual([DID]);
  });

  test('a failed open is not fatal: the next call opens the database', async () => {
    const idb = new IDBFactory();
    let opens = 0;
    const flaky = new Proxy(idb, {
      get(target, key) {
        if (key === 'open') return (name: string, version?: number) => (++opens === 1 ? (() => { throw new DOMException('transient', 'UnknownError'); })() : target.open(name, version));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new BrowserOriginalsStore('suborg-a', flaky as IDBFactory);
    await expect(store.list()).rejects.toThrow('transient');
    expect(await store.list()).toEqual([]);
  });

  test('without IndexedDB, a call fails by name', async () => {
    const saved = globalThis.indexedDB;
    globalThis.indexedDB = undefined as unknown as IDBFactory;
    try {
      await expect(new BrowserOriginalsStore('suborg-a').list()).rejects.toThrow(/IndexedDB/);
    } finally {
      globalThis.indexedDB = saved;
    }
  });
});
