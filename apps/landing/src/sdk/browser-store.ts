/** Account-scoped local persistence. Atomic head CAS is P6.2; retained state is P7.8.
 * No server/cross-device durability is implied by this IndexedDB database.
 *
 * The one IndexedDB store for Originals in this browser (#976 B, G2): signed
 * in, the account's database; signed out, the guest's (owner decision of
 * 23 October 2026). The retained anchor is kept, so a change of anchor is
 * reported after a restart too, never silent (P9.16).
 *
 * Each call opens the database, works in one transaction and closes it, so a
 * failed open is retried by the next call. Other tabs: a connection closes as
 * soon as another tab upgrades the schema (`versionchange`), and an open that
 * an older tab blocks waits for it instead of failing (#976 B, G2).
 */
import { headOf, higherVersion, refusedVersionId, staleHead, type OriginalsStore, type CommitUpdate, type StoredOriginal, type StoredPending, type StoredRefused } from '@originals/sdk/originals';
import type { AuthorDidEvidence, RetainedAnchor } from '@originals/vh/originals';
import { createLocalAuthor, restoreLocalAuthor, type LocalAuthor } from './local-author';
import type { PublicationRecord, PublicationRecords } from './publication-records';

export const browserDatabase = (account?: string) => `originals-library-v1:${account ? `account:${account}` : 'guest'}`;

export class BrowserOriginalsStore implements OriginalsStore, PublicationRecords {
  /** `factory` overrides the page's IndexedDB, for tests. */
  constructor(readonly account?: string, private readonly factory?: IDBFactory) {}
  private async transaction<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const idb = this.factory ?? globalThis.indexedDB;
      if (!idb) { reject(new Error('This browser has no IndexedDB, so your work can’t be kept here. Export your evidence before leaving.')); return; }
      const r = idb.open(browserDatabase(this.account), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('data');
      r.onsuccess = () => {
        // Give way to another tab's upgrade rather than block it for as long as this transaction lasts.
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
      // An older tab still holds the database. Not fatal: the open proceeds
      // when it closes. Rejecting here would leave the connection that later
      // succeeds open, owned by no one.
      r.onblocked = () => {};
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('data', mode);
        let result: T;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Saving in this browser failed. Export your evidence before leaving.'));
        try { work(tx.objectStore('data'), (v) => { result = v; }, (error) => { tx.abort(); reject(error); }); } catch (e) { tx.abort(); reject(e); }
      });
    } finally { db.close(); }
  }
  private getValue<T>(key: string): Promise<T | undefined> {
    return this.transaction('readonly', (s, done) => { s.get(key).onsuccess = (e) => done((e.target as IDBRequest).result); });
  }
  private put(key: string, value: unknown): Promise<void> {
    return this.transaction('readwrite', (s, done) => { s.put(value, key); done(undefined); });
  }
  private change<T>(key: string, fn: (value: T | undefined) => T): Promise<void> {
    return this.transaction('readwrite', (s, done, fail) => {
      const r = s.get(key);
      r.onsuccess = () => {
        try { const next = fn(r.result); if (next !== undefined) s.put(next, key); done(undefined); }
        catch (error) { fail(error); }
      };
    });
  }
  getForm<T = unknown>(key: string): Promise<T | null | undefined> { return this.getValue<T | null>(`form:${key}`); }
  putForm(key: string, value: unknown): Promise<void> { return this.put(`form:${key}`, value); }
  async localAuthor(): Promise<LocalAuthor> {
    type Saved = Pick<LocalAuthor, 'ref' | 'evidence' | 'secret'>;
    const key = 'local-author';
    let saved = await this.getValue<Saved>(key);
    if (!saved) {
      const { ref, evidence, secret } = await createLocalAuthor();
      await this.change<Saved>(key, (old) => old ?? { ref, evidence, secret });
      saved = await this.getValue<Saved>(key);
    }
    return restoreLocalAuthor(saved!);
  }
  get(did: string) { return this.getValue<StoredOriginal>(`log:${did}`); }
  async commit(did: string, update: CommitUpdate) {
    // The read and conditional write share one IDB transaction, including across tabs.
    let conflict: Error | undefined;
    await this.change<StoredOriginal>(`log:${did}`, (old) => {
      const actual = headOf(old?.log);
      if (actual !== update.expectedHead) { conflict = staleHead(did, update.expectedHead, actual); return old!; }
      return { log: update.log };
    });
    if (conflict) throw conflict;
  }
  // Content addressed: the first bytes stored for a digest stay, as in the SDK's MemoryStore.
  putResource(digest: string, bytes: Uint8Array) { return this.change<Uint8Array>(`bytes:${digest}`, (old) => old ?? bytes.slice()); }
  getResource(digest: string) { return this.getValue<Uint8Array>(`bytes:${digest}`); }
  putAuthorEvidence(evidence: AuthorDidEvidence) { return this.put(`author:${evidence.did}`, evidence); }
  getAuthorEvidence(did: string) { return this.getValue<AuthorDidEvidence>(`author:${did}`); }
  getRetained(did: string) { return this.getValue<string>(`retained:${did}`); }
  putRetained(did: string, id: string) { return this.change<string>(`retained:${did}`, (old) => higherVersion(old, id)); }
  getRetainedAnchor(did: string) { return this.getValue<RetainedAnchor>(`anchor:${did}`); }
  putRetainedAnchor(did: string, anchor: RetainedAnchor) { return this.put(`anchor:${did}`, anchor); }
  // Each Original's publication record (#976 B, G4). A key like the others, so no schema change.
  getPublication(did: string) { return this.getValue<PublicationRecord>(`publication:${did}`); }
  putPublication(did: string, record: PublicationRecord) { return this.put(`publication:${did}`, structuredClone(record)); }
  putBranch(did: string, log: string) { return this.change<string[]>(`branches:${did}`, (old = []) => old.includes(log) ? old : [...old, log]); }
  async getBranches(did: string) { return (await this.getValue<string[]>(`branches:${did}`)) ?? []; }
  putRefused(did: string, refused: StoredRefused) {
    return this.change<StoredRefused[]>(`refused:${did}`, (old = []) => {
      const at = old.findIndex((r) => refusedVersionId(r) === refusedVersionId(refused));
      return at < 0 ? [...old, refused] : old.map((r, i) => i === at && r.entry === refused.entry ? refused : r);
    });
  }
  async getRefused(did: string) { return (await this.getValue<StoredRefused[]>(`refused:${did}`)) ?? []; }
  dropRefused(did: string, id: string) { return this.change<StoredRefused[]>(`refused:${did}`, (old = []) => old.filter((r) => refusedVersionId(r) !== id)); }
  putPending(did: string, value: StoredPending | null) { return this.put(`pending:${did}`, value); }
  async getPending(did: string) { return (await this.getValue<StoredPending | null>(`pending:${did}`)) ?? undefined; }
  list(): Promise<string[]> {
    return this.transaction('readonly', (s, done) => {
      const r = s.getAllKeys();
      r.onsuccess = () => done(r.result.filter((k): k is string => typeof k === 'string' && k.startsWith('log:')).map((k) => k.slice(4)));
    });
  }
}
