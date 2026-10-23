/**
 * The signed-in browser's durable Originals store (#976 B, gap G2): an
 * `OriginalsStore` in IndexedDB, one database per Turnkey sub-org, so an
 * author's work survives a browser restart. Signed out, the engine keeps
 * `MemoryStore`: that work is page-scoped by design.
 *
 * It keeps the SDK's store contract (`@originals/sdk/originals` store.ts):
 * - a commit replaces the log in one readwrite transaction, only if the stored
 *   head is the expected one (P6.2). IndexedDB serializes readwrite
 *   transactions on a store, so two tabs on one parent can't both commit;
 * - resource bytes are content addressed and the first copy stays;
 * - retained versionIds never go down (P7.8);
 * - refused candidates are kept beside the log, never in it (P6.8), and the
 *   pending candidate until the host answers (P6.4).
 *
 * It also keeps each Original's publication record (G4), so a publication
 * interrupted by a restart resumes under the same alias.
 *
 * Nothing here is trusted on read: the SDK verifies logs, evidence and byte
 * digests every time (P8.1). No private key is ever written here.
 */
import type { AliasEvidence, AuthorDidEvidence } from "@originals/vh/originals";
import {
  headOf,
  higherVersion,
  refusedVersionId,
  staleHead,
  type CommitUpdate,
  type OriginalsStore,
  type StoredOriginal,
  type StoredPending,
  type StoredRefused,
} from "@originals/sdk/originals";

// 2 adds `publications` (#976 B, G4). Upgrades only add tables.
const VERSION = 2;
const TABLES = ["originals", "resources", "authors", "retained", "branches", "refused", "pending", "publications"] as const;
type Table = (typeof TABLES)[number];

/** The database for one account. */
export function storeName(subOrgId: string): string {
  return `originals-store:${subOrgId}`;
}

/**
 * Where an Original's web publication stands (#976 B, G4, G5). `started`: the
 * alias is built, so a retry reuses it; `uploaded`: the publish entry is
 * committed and every file was put; `complete`: a stranger with no cookie
 * verified the exact snapshot, every byte included. The alias log is public,
 * so nothing secret is here.
 */
export interface PublicationRecord {
  alias: AliasEvidence;
  state: "started" | "uploaded" | "complete";
}

/** A store that also keeps publication records. */
export interface PublicationRecords {
  getPublication(did: string): Promise<PublicationRecord | undefined>;
  putPublication(did: string, record: PublicationRecord): Promise<void>;
}

/** Publication records in memory, for a store that has none of its own. */
export class MemoryPublicationRecords implements PublicationRecords {
  private readonly records = new Map<string, PublicationRecord>();
  getPublication(did: string): Promise<PublicationRecord | undefined> {
    const record = this.records.get(did);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }
  putPublication(did: string, record: PublicationRecord): Promise<void> {
    this.records.set(did, structuredClone(record));
    return Promise.resolve();
  }
}

export function hasPublicationRecords(store: object): store is PublicationRecords {
  return typeof (store as Partial<PublicationRecords>).getPublication === "function" && typeof (store as Partial<PublicationRecords>).putPublication === "function";
}

type Body<T> = (table: (name: Table) => IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void;

export class IndexedDbStore implements OriginalsStore, PublicationRecords {
  private constructor(private readonly db: IDBDatabase) {}

  /** Open (or create) the account's database. */
  static open(subOrgId: string, factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbStore> {
    if (!factory) return Promise.reject(new Error("This browser has no IndexedDB, so work can't be kept."));
    return new Promise((resolve, reject) => {
      const request = factory.open(storeName(subOrgId), VERSION);
      request.onupgradeneeded = () => {
        for (const name of TABLES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(new IndexedDbStore(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Another tab is upgrading this store; close it and try again."));
    });
  }

  close(): void {
    this.db.close();
  }

  /** One transaction; settles when it commits, or with the first failure. */
  private run<T>(tables: Table[], mode: IDBTransactionMode, body: Body<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(tables, mode);
      let value: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error);
      tx.onerror = () => {
        failure ??= tx.error;
      };
      try {
        body(
          (name) => tx.objectStore(name),
          (v) => {
            value = v;
          },
          (error) => {
            failure = error;
            tx.abort();
          },
        );
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }

  private read<T>(table: Table, key: string): Promise<T | undefined> {
    return this.run<T | undefined>([table], "readonly", (t, done) => {
      const request = t(table).get(key);
      request.onsuccess = () => done(request.result as T | undefined);
    });
  }

  /** Read, change and write one key in a single readwrite transaction. */
  private update<T>(table: Table, key: string, change: (current: T | undefined) => T | undefined | Error): Promise<void> {
    return this.run<void>([table], "readwrite", (t, _done, fail) => {
      const store = t(table);
      const request = store.get(key);
      request.onsuccess = () => {
        const next = change(request.result as T | undefined);
        if (next instanceof Error) fail(next);
        else if (next !== undefined) store.put(next, key);
      };
    });
  }

  get(did: string): Promise<StoredOriginal | undefined> {
    return this.read<StoredOriginal>("originals", did);
  }

  commit(did: string, update: CommitUpdate): Promise<void> {
    return this.update<StoredOriginal>("originals", did, (current) => {
      const head = headOf(current?.log);
      return head === update.expectedHead ? { log: update.log } : staleHead(did, update.expectedHead, head);
    });
  }

  putResource(digest: string, bytes: Uint8Array): Promise<void> {
    return this.update<Uint8Array>("resources", digest, (current) => (current ? undefined : bytes.slice()));
  }

  async getResource(digest: string): Promise<Uint8Array | undefined> {
    const bytes = await this.read<Uint8Array>("resources", digest);
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  putAuthorEvidence(evidence: AuthorDidEvidence): Promise<void> {
    return this.update<AuthorDidEvidence>("authors", evidence.did, () => structuredClone(evidence));
  }

  getAuthorEvidence(did: string): Promise<AuthorDidEvidence | undefined> {
    return this.read<AuthorDidEvidence>("authors", did);
  }

  getRetained(did: string): Promise<string | undefined> {
    return this.read<string>("retained", did);
  }

  putRetained(did: string, versionId: string): Promise<void> {
    return this.update<string>("retained", did, (current) => higherVersion(current, versionId));
  }

  putBranch(did: string, log: string): Promise<void> {
    return this.update<string[]>("branches", did, (known = []) => (known.includes(log) ? undefined : [...known, log]));
  }

  async getBranches(did: string): Promise<string[]> {
    return (await this.read<string[]>("branches", did)) ?? [];
  }

  putRefused(did: string, refused: StoredRefused): Promise<void> {
    const id = refusedVersionId(refused);
    return this.update<StoredRefused[]>("refused", did, (known = []) => {
      const at = known.findIndex((r) => refusedVersionId(r) === id);
      if (at < 0) return [...known, { ...refused }];
      // The entry itself never changes; only its label does.
      return known[at].entry === refused.entry ? known.map((r, k) => (k === at ? { ...refused } : r)) : undefined;
    });
  }

  async getRefused(did: string): Promise<StoredRefused[]> {
    return (await this.read<StoredRefused[]>("refused", did)) ?? [];
  }

  dropRefused(did: string, versionId: string): Promise<void> {
    return this.update<StoredRefused[]>("refused", did, (known = []) => known.filter((r) => refusedVersionId(r) !== versionId));
  }

  putPending(did: string, pending: StoredPending | null): Promise<void> {
    if (pending) return this.update<StoredPending>("pending", did, () => ({ ...pending }));
    return this.run<void>(["pending"], "readwrite", (t) => {
      t("pending").delete(did);
    });
  }

  getPending(did: string): Promise<StoredPending | undefined> {
    return this.read<StoredPending>("pending", did);
  }

  getPublication(did: string): Promise<PublicationRecord | undefined> {
    return this.read<PublicationRecord>("publications", did);
  }

  putPublication(did: string, record: PublicationRecord): Promise<void> {
    return this.update<PublicationRecord>("publications", did, () => structuredClone(record));
  }

  list(): Promise<string[]> {
    return this.run<string[]>(["originals"], "readonly", (t, done) => {
      const request = t("originals").getAllKeys();
      request.onsuccess = () => done(request.result.map(String));
    });
  }
}
