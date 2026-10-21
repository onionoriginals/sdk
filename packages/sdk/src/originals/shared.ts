/**
 * Shared-host saves (P6.4, P6.7, P6.8): the contract between the SDK and a
 * host that accepts entries for one Original from several signers.
 *
 * The host checks a submission in this order (P6.7):
 *
 * 1. Byte-identical to an entry it already accepted: it answers
 *    `already-accepted` with that entry's checkpoint and its current head,
 *    without a new append, even when the head has moved on (P6.4).
 * 2. Otherwise it accepts only an entry whose parent is its accepted head at
 *    that moment and which verifies under the profile against that head, in
 *    one atomic step per Original, and stores the entry and any new resource
 *    bytes durably before answering or publishing the new head (P6.2).
 * 3. A parent that is not the head is a `stale-parent` conflict naming the
 *    head. The host never re-signs, rebases, reorders or changes a
 *    submission, and never publishes a refused one.
 *
 * The transport is the host's; `SharedHost` is what the SDK needs from it.
 * This gives one accepted append at a time at that host. It is not consensus
 * and does not prevent forks published elsewhere (P6.6).
 */
import type { AuthorDidEvidence } from "@originals/vh/originals";
import type { EvidenceContents } from "./evidence.js";

/** One save sent to a shared host. */
export interface Submission {
  /** The Original's did:vh. */
  original: string;
  /** The signed entry as one JSON line, no newline: exactly the bytes the host stores and compares. */
  entry: string;
  /** Bytes for each resource digest the entry introduces. */
  resources: Record<string, Uint8Array>;
  /** The DID histories of the entry's signer, as the SDK holds them. */
  identities: AuthorDidEvidence[];
}

/** What a shared host answers. Any other outcome (an invalid entry, an outage) is an error the transport throws. */
export type HostAnswer =
  | { status: "accepted" | "already-accepted"; checkpoint: string; head: string }
  | { status: "stale-parent"; head: string };

export interface SharedHost {
  submit(submission: Submission): Promise<HostAnswer>;
  /**
   * The host's accepted log with the evidence it serves beside it (signer DID
   * histories and resource bytes), as an evidence package's contents. The SDK
   * verifies it before using any of it.
   */
  accepted(original: string): Promise<EvidenceContents>;
}
