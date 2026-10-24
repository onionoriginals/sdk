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
