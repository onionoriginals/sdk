/**
 * BrowserOriginalsStore on an in-memory IndexedDB (fake-indexeddb): the head
 * compare-and-swap is one transaction (P6.2), and each account's database is
 * its own (P7.5).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserOriginalsStore, browserDatabase } from './browser-store';

const original = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
beforeEach(() => { (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory(); });
afterAll(() => { (globalThis as { indexedDB?: IDBFactory }).indexedDB = original; });

const DID = 'did:vh:QmBrowserStoreTest';
const entry = (versionId: string) => `${JSON.stringify({ versionId })}\n`;

describe('head compare-and-swap (P6.2)', () => {
  test('a commit lands only on the head it names; a stale head is a conflict and changes nothing (P4.5)', async () => {
    const store = new BrowserOriginalsStore('alice');
    await store.commit(DID, { expectedHead: null, log: entry('1-a') });
    expect((await store.get(DID))?.log).toBe(entry('1-a'));

    await expect(store.commit(DID, { expectedHead: null, log: entry('1-other') })).rejects.toThrow();
    await expect(store.commit(DID, { expectedHead: '1-wrong', log: entry('1-a') + entry('2-x') })).rejects.toThrow();
    expect((await store.get(DID))?.log).toBe(entry('1-a'));

    await store.commit(DID, { expectedHead: '1-a', log: entry('1-a') + entry('2-b') });
    expect((await store.get(DID))?.log).toBe(entry('1-a') + entry('2-b'));
  });

  test('two commits racing on the same head: exactly one lands, the other is a conflict (P6.2, P4.5)', async () => {
    const store = new BrowserOriginalsStore('alice');
    const other = new BrowserOriginalsStore('alice'); // another tab, same account
    await store.commit(DID, { expectedHead: null, log: entry('1-a') });
    const results = await Promise.allSettled([
      store.commit(DID, { expectedHead: '1-a', log: entry('1-a') + entry('2-left') }),
      other.commit(DID, { expectedHead: '1-a', log: entry('1-a') + entry('2-right') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const log = (await store.get(DID))!.log;
    expect([entry('1-a') + entry('2-left'), entry('1-a') + entry('2-right')]).toContain(log);
  });
});

describe('account isolation (P7.5)', () => {
  test('each account and the guest have their own database, Originals and guest author', async () => {
    expect(browserDatabase('alice')).not.toBe(browserDatabase('bob'));
    expect(browserDatabase()).not.toBe(browserDatabase('alice'));
    const alice = new BrowserOriginalsStore('alice');
    await alice.commit(DID, { expectedHead: null, log: entry('1-a') });
    await alice.putForm('new', { title: 'draft' });

    const bob = new BrowserOriginalsStore('bob');
    const guest = new BrowserOriginalsStore();
    expect(await alice.list()).toEqual([DID]);
    expect(await bob.list()).toEqual([]);
    expect(await guest.list()).toEqual([]);
    expect(await bob.get(DID)).toBeUndefined();
    expect(await bob.getForm('new')).toBeUndefined();

    // The guest author is stable for one database and never shared with another.
    const first = await guest.localAuthor();
    const again = await new BrowserOriginalsStore().localAuthor();
    expect(again.ref).toEqual(first.ref);
    expect((await alice.localAuthor()).ref.did).not.toBe(first.ref.did);
  });
});
