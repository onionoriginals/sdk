/**
 * Carried logs for did:og (P7.11–P7.16, P14.14–P14.17): one resource version
 * with the Original's asset log added in the carrier its media type has, a
 * trailer, a text block or a JSON member. The carriers themselves (finding,
 * removing and writing them) are format-level and shared with the earlier
 * profile's module; the log is verified here under did:og (P3.5).
 *
 * A carried file is never an evidence package and makes no claim to be
 * complete (P7.11). Its signer histories are not in it: they come from the
 * caller, and a resolver is asked only on the caller's opt-in for this one
 * read (P7.13), never because a file was opened, previewed or imported.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import type { LogEntry } from "../log/index.js";
import { carriedDisclosure, carrierFor, locateCarrier, removeCarrier, sameCarrier, writeCarriedFile, type Carrier, type CarriedDisclosure } from "../originals/carried.js";
import { resourceDigest, serializeLog, type OgEntry } from "./log.js";
import type { EvidenceInput, EvidenceSet, Report, SatRead } from "./report.js";
import { stateOf, type BitcoinNetwork } from "./state.js";
import { verifyOriginal } from "./verify.js";

export { carrierFor, removeCarrier, type Carrier, type CarriedDisclosure };

const enc = new TextEncoder();

export interface CarriedSignerHistory {
  did: string;
  log: Uint8Array | string;
  source: string;
  obtained?: string;
}

export interface ReadCarriedOptions {
  /** A file name, extension or declared media type: only a hint of which carrier to try first (P14.14). */
  hint?: string;
  /** Signer DID histories the caller already holds or was given (P7.13). Using them makes no request. */
  histories?: CarriedSignerHistory[];
  /**
   * The caller's opt-in, for this one read, to resolve the signer DIDs the log names that `histories`
   * does not cover (P7.13, P8.5). There is no standing opt-in: pass it only on an explicit request.
   */
  resolveSigners?: (did: string) => Promise<CarriedSignerHistory | undefined>;
  /** Bitcoin reads for an anchored Original: its state is derived from the anchor, never the carried log (P7.14). */
  bitcoin?: { network: BitcoinNetwork; tip: { height: number; hash: string }; depth?: number; sats: SatRead[]; inscriptions: EvidenceInput[] };
}

export interface CarriedFileReport {
  kind: "carried-file";
  /** P7.11: a carried file is never an evidence package and makes no claim to be complete. */
  completeness: "no-claim";
  /**
   * The file as a whole (P7.12). `verified` only when the carrier is the one the last entry's media type
   * has, the remaining bytes are that version, and the log verified. `failed` with a reason otherwise;
   * proofs that verified are detail (`report`) and never make it a pass. `incomplete` when nothing
   * contradicts it but evidence is missing (unchecked proofs, an unread anchor).
   */
  overall: { status: "verified" | "failed" | "incomplete"; reason: string | null };
  carrierStatus: "found" | "none" | "mismatch" | "stray" | "rejected";
  carrier: Carrier | null;
  expectedCarrier: Carrier | null;
  /** The file without the carrier's bytes (P7.12), when a carrier was found. */
  version?: Uint8Array;
  bytes?: "match" | "mismatch";
  log?: { status: "parsed" | "invalid"; entries: number };
  original: string | null;
  checkpoint: string | null;
  signers: { given: string[]; resolved: string[]; unavailable: string[]; requested: boolean };
  /** The carried log's own verification report under did:og, separate from the file's result (P7.12). */
  report?: Report;
  statements: string[];
}

const signerDids = (entries: JsonValue[]) => [...new Set(entries.flatMap((e) => {
  if (!isJsonObject(e) || !isJsonObject(e.state)) return [];
  return ["author", "editor"].map((k) => (e.state as JsonObject)[k]).filter(isJsonObject).map((r) => r.did).filter((d): d is string => typeof d === "string");
}))];

/** Read a carried file (P7.12–P7.14). */
export async function readCarriedFile(file: Uint8Array, options: ReadCarriedOptions = {}): Promise<CarriedFileReport> {
  const out: CarriedFileReport = {
    kind: "carried-file", completeness: "no-claim", overall: { status: "failed", reason: "no-carrier" }, carrierStatus: "none", carrier: null, expectedCarrier: null,
    original: null, checkpoint: null, signers: { given: [], resolved: [], unavailable: [], requested: false },
    statements: ["A carried file is not an evidence package and makes no claim to be complete (P7.11)."],
  };
  const found = locateCarrier(file, options.hint !== undefined ? { hint: options.hint } : {});
  if (found.status === "rejected") {
    out.carrierStatus = "rejected";
    out.overall = { status: "failed", reason: found.reason };
    out.statements.push("The JSON root object has more than one originalLog member: neither is read (P14.17).");
    return out;
  }
  let entries: JsonValue[];
  if (found.status === "none") {
    if (!found.stray) return out;
    out.carrierStatus = "stray";
    out.log = { status: found.stray.log.status, entries: found.stray.log.entries.length };
    if (found.stray.log.status === "invalid") {
      out.overall = { status: "failed", reason: "carried-log-invalid" };
      return out;
    }
    entries = found.stray.log.entries;
  } else {
    out.carrierStatus = "found";
    out.carrier = found.carrier;
    out.version = found.version;
    out.log = { status: found.log.status, entries: found.log.entries.length };
    if (found.log.status === "invalid") {
      // An invalid log is still a carrier, never content (P14.15–P14.17).
      out.overall = { status: "failed", reason: "carried-log-invalid" };
      out.statements.push("This file has a carried log, but the log is invalid: nothing in it is verified.");
      return out;
    }
    entries = found.log.entries;
  }
  const last = entries[entries.length - 1] as OgEntry;
  const first = entries[0] as OgEntry;
  out.checkpoint = typeof last?.versionId === "string" ? last.versionId : null;
  out.original = isJsonObject(first?.state) && typeof first.state.id === "string" ? first.state.id : null;
  let descriptor: { mediaType: string; size: number; digest: string } | undefined;
  try {
    descriptor = stateOf(last).asset.resource;
  } catch {
    descriptor = undefined;
  }
  out.expectedCarrier = descriptor ? carrierFor(descriptor.mediaType) : null;
  if (out.carrierStatus === "found" && !sameCarrier(out.carrier, out.expectedCarrier)) out.carrierStatus = "mismatch";
  if (out.carrierStatus === "found" && descriptor && out.version) {
    out.bytes = out.version.length === descriptor.size && resourceDigest(out.version) === descriptor.digest ? "match" : "mismatch";
  }

  // Signer histories: as given, then resolved only on this read's opt-in (P7.13).
  const dids = signerDids(entries);
  const histories = (options.histories ?? []).filter((h) => dids.includes(h.did));
  out.signers.given = histories.map((h) => h.did);
  if (options.resolveSigners) {
    out.signers.requested = true;
    for (const did of dids) {
      if (histories.some((h) => h.did === did)) continue;
      const h = await options.resolveSigners(did);
      if (h && h.did === did) {
        histories.push(h);
        out.signers.resolved.push(did);
      } else out.signers.unavailable.push(did);
    }
  } else out.signers.unavailable = dids.filter((d) => !histories.some((h) => h.did === d));

  // The carried log verified under did:og (P3.5), as one more copy of the log; its bytes only if they are the version.
  const evidence: EvidenceSet = {
    original: out.original ?? "",
    inputs: [
      { kind: "log", source: `carried:${out.carrier?.kind ?? "stray"}`, bytes: enc.encode(serializeLog(entries as JsonObject[])) },
      ...histories.map((h) => ({ kind: "signer-history" as const, source: h.source, did: h.did, bytes: typeof h.log === "string" ? enc.encode(h.log) : h.log })),
      ...(out.bytes === "match" && out.version ? [{ kind: "resource" as const, source: "carried:version", bytes: out.version }] : []),
      ...(options.bitcoin?.inscriptions ?? []),
    ],
    signerHistories: histories.map((h) => ({ did: h.did, source: h.source, obtained: h.obtained })),
    network: options.bitcoin?.network ?? null,
    tip: options.bitcoin?.tip ?? null,
    depth: options.bitcoin?.depth ?? (options.bitcoin ? 1 : null),
    ...(options.bitcoin ? { sats: options.bitcoin.sats } : {}),
  };
  const report = await verifyOriginal(evidence);
  out.report = report;
  const axes = report.axes as Record<string, string>;
  // The file as a whole (P7.12): any carrier or byte problem fails it, whatever the proofs gave.
  if (out.carrierStatus === "stray") {
    out.overall = { status: "failed", reason: "json-member-not-last" };
    out.statements.push("This file carries a log in an originalLog member that is not the root object's last: the log is reported, but the file is not verified as a version of the Original (P7.12, P14.17).");
  } else if (out.carrierStatus === "mismatch") {
    out.overall = { status: "failed", reason: "carrier-not-for-media-type" };
  } else if (out.bytes === "mismatch") {
    out.overall = { status: "failed", reason: "file-digest-mismatch" };
    out.statements.push(`This file carries the log of ${out.original} at ${out.checkpoint}, but it is not a version of that Original: its bytes do not match the version the log names.`);
  } else if (axes.outcome === "invalid") {
    out.overall = { status: "failed", reason: "carried-log-invalid" };
  } else if (axes.outcome !== "verified") {
    out.overall = { status: "incomplete", reason: axes.identity === "incomplete" ? "proofs-unchecked" : axes.bitcoin === "missing-evidence" ? "bitcoin-evidence-missing" : "incomplete" };
  } else out.overall = { status: "verified", reason: null };
  return out;
}

/** P7.15: what a carried file will disclose, to show the user before writing it. */
export function carriedOgDisclosure(entries: OgEntry[]): CarriedDisclosure {
  return carriedDisclosure(entries as unknown as LogEntry[]);
}

/**
 * Write a carried file (P7.11, P7.15): `version` with `entries`, genesis through an accepted checkpoint,
 * in the carrier the last entry's media type has. Refuses a draft, bytes other than the last entry's
 * version, a preview, a media type with no carrier, a carrier P14.16 or P14.17 forbids, and a write without
 * the disclosure shown first. Adding a carrier signs nothing (P7.16).
 */
export function writeCarriedOgFile(version: Uint8Array, entries: OgEntry[], options: { disclosed: CarriedDisclosure }): Promise<Uint8Array> {
  return writeCarriedFile(version, entries as unknown as LogEntry[], options);
}
