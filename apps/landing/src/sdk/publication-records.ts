/**
 * Publication records (#976 B, G4): where each Original's web publication
 * stands, kept beside it so a publication interrupted by a restart resumes
 * under the same alias. BrowserOriginalsStore keeps them in IndexedDB;
 * MemoryPublicationRecords stands in for a store that keeps none.
 */
import type { AliasEvidence } from "@originals/vh/originals";

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
  /**
   * Whether the account's library lists it for the author's other clients
   * (G3), apart from `state`: an index failure never makes a verified
   * publication incomplete. Absent when the engine keeps no index.
   */
  indexed?: boolean;
}

/** A store that also keeps publication records. */
export interface PublicationRecords {
  getPublication(did: string): Promise<PublicationRecord | undefined>;
  putPublication(did: string, record: PublicationRecord): Promise<void>;
}

const RANK: Record<PublicationRecord["state"], number> = { started: 0, uploaded: 1, complete: 2 };

/**
 * The record to keep when `next` is written over `current`. A record only
 * moves forward (started < uploaded < complete), and a listed one stays
 * listed, so a late or failed writer, or a second tab, never downgrades a
 * verified publication. Same idea as the SDK's `higherVersion` for retained
 * versionIds (P7.8).
 */
export function higherPublication(current: PublicationRecord | undefined, next: PublicationRecord): PublicationRecord {
  if (!current) return structuredClone(next);
  if (RANK[next.state] < RANK[current.state]) return structuredClone(current);
  const indexed = current.indexed === true || next.indexed === true ? true : next.indexed ?? current.indexed;
  return structuredClone({ ...next, ...(indexed === undefined ? {} : { indexed }) });
}

/** Publication records in memory, for a store that has none of its own. */
export class MemoryPublicationRecords implements PublicationRecords {
  private readonly records = new Map<string, PublicationRecord>();
  getPublication(did: string): Promise<PublicationRecord | undefined> {
    const record = this.records.get(did);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }
  putPublication(did: string, record: PublicationRecord): Promise<void> {
    this.records.set(did, higherPublication(this.records.get(did), record));
    return Promise.resolve();
  }
}

export function hasPublicationRecords(store: object): store is PublicationRecords {
  return typeof (store as Partial<PublicationRecords>).getPublication === "function" && typeof (store as Partial<PublicationRecords>).putPublication === "function";
}
