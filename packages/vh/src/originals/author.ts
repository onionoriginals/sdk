/**
 * Author DID histories and the author binding of each entry (P5.2, P5.3,
 * P5.8, P5.11). Author keys are ordinary assertionMethod verification methods
 * of the author DID (owner decision Q6; plan 011, S8).
 */
import { decodeMultikey } from "../crypto/index.js";
import { OriginalsError, fail } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { parseLog, verifyLog, type LogFailure } from "../log/index.js";
import { didVh } from "../didvh/index.js";
import { didWebvh } from "../webvh/index.js";
import { ORIGINALS_LIMITS, type AuthorRef } from "./state.js";

/** The author DID methods the baseline profile lists (P5.8). did:btco arrives with Bitcoin (plan 011, PR 9). */
export type AuthorMethod = "did:vh" | "did:webvh" | "did:btco";

export function authorMethod(did: string): AuthorMethod {
  for (const method of ["did:vh", "did:webvh", "did:btco"] as const) if (did.startsWith(`${method}:`)) return method;
  return fail("unsupported-profile", "AUTHOR_METHOD_NOT_LISTED", `author DID ${did} uses a method the profile does not list`);
}

/** The author DID's log and witness file, as supplied in evidence. */
export interface AuthorDidEvidence {
  did: string;
  log: string | unknown[];
  witness?: unknown;
}

export interface AuthorVersion {
  versionId: string;
  versionNumber: number;
  /** versionTime in epoch milliseconds. */
  time: number;
  document: JsonObject;
  /** The author DID log's update keys in effect after this version. */
  updateKeys: string[];
  deactivated: boolean;
}

export interface AuthorHistory {
  did: string;
  method: AuthorMethod;
  /** The verified versions, oldest first. */
  versions: AuthorVersion[];
  /** Why verification stopped before the end of the supplied log, if it did. */
  failure?: LogFailure;
}

export interface AuthorHistoryOptions {
  now?: number | Date;
  maxVersions?: number;
}

/** Verify a did:vh or did:webvh author DID log. Invalid trailing entries are dropped and reported. */
export async function verifyAuthorHistory(evidence: AuthorDidEvidence, options: AuthorHistoryOptions = {}): Promise<AuthorHistory> {
  const method = authorMethod(evidence.did);
  if (method === "did:btco") fail("unsupported-profile", "AUTHOR_METHOD_NOT_IMPLEMENTED", "did:btco author DIDs are verified from Bitcoin (plan 011, PR 9)");
  let entries: unknown[];
  try {
    entries = typeof evidence.log === "string" ? parseLog(evidence.log) : evidence.log;
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
    return { did: evidence.did, method, versions: [], failure: { index: 0, error } };
  }
  const log = await verifyLog(entries, {
    specialisation: method === "did:vh" ? didVh : didWebvh,
    witnessFile: evidence.witness,
    now: options.now,
    limits: { maxEntries: options.maxVersions ?? ORIGINALS_LIMITS.authorVersions },
  });
  const versions = log.entries.map((v) => ({
    versionId: v.entry.versionId,
    versionNumber: v.versionNumber,
    time: v.time,
    document: v.entry.state,
    updateKeys: v.active.updateKeys,
    deactivated: v.active.deactivated,
  }));
  const scidOk = method === "did:vh" ? log.scid === evidence.did.slice("did:vh:".length) : versions.some((v) => v.document.id === evidence.did);
  if (versions.length > 0 && !scidOk) {
    return { did: evidence.did, method, versions: [], failure: { index: 0, error: new OriginalsError("invalid-evidence", "AUTHOR_LOG_MISMATCH", "the supplied log is not this DID's") } };
  }
  return { did: evidence.did, method, versions, ...(log.failure ? { failure: log.failure } : {}) };
}

export function versionNumberOf(versionId: string): number {
  const n = Number(/^(\d+)-/.exec(versionId)?.[1] ?? NaN);
  return Number.isInteger(n) ? n : NaN;
}

function binding(code: string, message: string): never {
  throw new OriginalsError("author-binding", code, message);
}

function sameId(reference: JsonValue, absolute: string, documentId: string): boolean {
  return typeof reference === "string" && (reference === absolute || (reference.startsWith("#") && `${documentId}${reference}` === absolute));
}

/** The version of `history` that `ref` names, or an incomplete-evidence failure. */
export function namedVersion(history: AuthorHistory, ref: AuthorRef): AuthorVersion {
  const version = history.versions.find((v) => v.versionId === ref.versionId);
  if (!version) {
    fail("incomplete-evidence", "AUTHOR_VERSION_UNAVAILABLE", `author DID version ${ref.versionId} is not in the verified author history`);
  }
  return version;
}

/**
 * P5.3: the Multikey that verifies an entry by `ref`. The verification method
 * must be embedded in the author DID document at the named version, listed
 * under assertionMethod, controlled by the author DID, of type Multikey, and
 * not an update key of the author DID's own log (P5.11).
 */
export function authorKey(version: AuthorVersion, ref: AuthorRef): string {
  const doc = version.document;
  const docId = typeof doc.id === "string" ? doc.id : ref.did;
  if (!ref.verificationMethod.startsWith(`${ref.did}#`)) binding("AUTHOR_VM_FOREIGN", "the verification method is not in the author DID's namespace");
  const embeddedIn = (list: JsonValue | undefined) =>
    Array.isArray(list) ? list.filter(isJsonObject).find((vm) => sameId(vm.id, ref.verificationMethod, docId)) : undefined;
  const vm = embeddedIn(doc.verificationMethod) ?? embeddedIn(doc.assertionMethod);
  if (!vm) binding("AUTHOR_VM_NOT_IN_DOCUMENT", "the verification method is not embedded in the author DID document at that version");
  const assertion = Array.isArray(doc.assertionMethod) ? doc.assertionMethod : [];
  const listed = assertion.some((item) => sameId(item, ref.verificationMethod, docId) || (isJsonObject(item) && sameId(item.id, ref.verificationMethod, docId)));
  if (!listed) binding("AUTHOR_VM_RELATIONSHIP", "the verification method is not listed under assertionMethod");
  if (vm.type !== "Multikey") binding("AUTHOR_VM_TYPE", "the verification method must have type Multikey");
  if (vm.controller !== ref.did) binding("AUTHOR_VM_CONTROLLER", "the verification method's controller must be the author DID");
  if (typeof vm.publicKeyMultibase !== "string") binding("AUTHOR_KEY_ENCODING", "the verification method must carry publicKeyMultibase");
  try {
    decodeMultikey(vm.publicKeyMultibase);
  } catch {
    binding("AUTHOR_KEY_ENCODING", "publicKeyMultibase is not a supported Multikey");
  }
  if (version.updateKeys.includes(vm.publicKeyMultibase)) {
    binding("AUTHOR_KEY_IS_UPDATE_KEY", "an update key of the author DID's own log cannot sign Originals entries (P5.11)");
  }
  return vm.publicKeyMultibase;
}

/** True when `version` still lists `ref`'s key under assertionMethod (for P7.9). */
export function stillAuthorized(version: AuthorVersion, ref: AuthorRef, publicKeyMultibase: string): boolean {
  try {
    return authorKey(version, ref) === publicKeyMultibase;
  } catch (error) {
    if (error instanceof OriginalsError) return false;
    throw error;
  }
}
