/**
 * Signer DID histories for did:og (P5.3, P5.8, P5.13, P5.14, P7.8) and
 * the signer binding of one entry. did:webvh and did:vh histories are always
 * supplied in the evidence set, never inscribed (D22). The baseline lists did:webvh, the DIF
 * did:vh and did:btco (P5.8). did:webvh and did:vh logs are verified from
 * their genesis with the VH engine under their own method's rules; did:btco
 * versions come from the DID's own sat (P5.13) and are supplied by the
 * Bitcoin layer.
 */
import { decodeMultikey, verifyProof, type DataIntegrityProof } from "../crypto/index.js";
import { OriginalsError } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { verifyLog, type Specialisation } from "../log/index.js";
import { DID_WEBVH_1_0, didWebvh, parseDidWebvh } from "../webvh/index.js";
import type { OgEntry } from "./log.js";
import { OG_LIMITS, reject } from "./rules.js";
import { signerMethodOf, type SignerMethod, type SignerRef } from "./state.js";

/** One version of a signer DID. */
export interface SignerVersion {
  versionId: string;
  /** The version number (did:webvh, did:vh) or position in chain order from 1 (did:btco). */
  number: number;
  document: JsonObject;
  deactivated: boolean;
  /** The DID's own updateKeys at this version, which may not sign entries (P5.3). */
  updateKeys: string[];
  /** For a did:btco version: the inscription that carries it. */
  inscription?: string;
}

/** A verified signer DID history. */
export interface SignerHistory {
  did: string;
  method: SignerMethod;
  versions: SignerVersion[];
  /** True when the history is longer than P14.13's 1,000 versions; `versions` is its valid prefix. */
  limitExceeded: boolean;
  /** Why the history stops where it does, when it does not verify to its end. */
  failure?: OriginalsError;
  /** Whether the DID's own witnesses support its latest version (P7.8). */
  witnessed: boolean;
}

/**
 * The DIF did:vh [S3], for author and editor DIDs (D10): did:webvh's format,
 * SCID, entry hash, key authorization, pre-rotation, witnesses and watchers,
 * method value `did:vh:1.0`, whole-second versionTimes, no `portable` and no
 * location; its id is `did:vh:<SCID>`.
 */
export const didVhDif: Specialisation = {
  name: "did:vh (DIF)",
  versionParameter: "method",
  versions: { "did:vh:1.0": DID_WEBVH_1_0 },
  keys: { kind: "updateKeys" },
  versionTime: { fractionalDigits: 0 },
  validateEntry: ({ entry, scid }) => {
    if (entry.state.id !== `did:vh:${scid}`) reject("P5.8", "DIDVH_STATE_ID", "a did:vh's state.id is did:vh:<SCID>");
  },
};

/** A fixed resolution time, so a history's verification never depends on the wall clock (P7.17). */
const NO_CLOCK = 8_640_000_000_000_000;

/**
 * Verify a did:webvh or did:vh signer's log, from its genesis, under its own
 * method (P5.8, P5.14). Versions beyond 1,000 are not used and the history is
 * marked limit-exceeded (P14.13, P7.7).
 */
export async function verifySignerLog(did: string, entries: readonly JsonValue[], witnessFile?: unknown): Promise<SignerHistory> {
  const method = signerMethodOf(did);
  if (method !== "did:webvh" && method !== "did:vh") reject("P5.8", "SIGNER_METHOD", `${did} has no log of its own to verify`);
  const specialisation = method === "did:webvh" ? didWebvh : didVhDif;
  const limitExceeded = entries.length > OG_LIMITS.signerVersions;
  const log = await verifyLog(entries.slice(0, OG_LIMITS.signerVersions), { specialisation, witnessFile, now: NO_CLOCK });
  const out: SignerHistory = { did, method, versions: [], limitExceeded, witnessed: false };
  if (log.entries.length === 0) {
    out.failure = log.failure?.error ?? new OriginalsError("incomplete-evidence", "SIGNER_LOG_EMPTY", "the log has no entries");
    return out;
  }
  // The log must be this identity's: same SCID, and the DID among its versions (P5.14).
  const scid = method === "did:webvh" ? parseDidWebvh(did).scid : did.slice("did:vh:".length);
  if (log.scid !== scid || !log.entries.some((v) => v.entry.state.id === did)) {
    out.failure = new OriginalsError("invalid-evidence", "SIGNER_LOG_IDENTITY", `the log is not ${did}'s own (P5.14)`, { rule: "P5.14" });
    return out;
  }
  out.versions = log.entries.map((v) => ({
    versionId: v.entry.versionId,
    number: v.versionNumber,
    document: v.entry.state,
    deactivated: v.active.deactivated,
    updateKeys: v.active.updateKeys,
  }));
  // P5.8, P9.33 (owner decision B, 22 November 2026): a signer's log is evidence exactly when it verifies in
  // full from its genesis under its method's rules; a log that fails anywhere is no evidence for that signer
  // at all, never a valid prefix, whichever method it is.
  if (log.failure) {
    out.failure = log.failure.error;
    out.versions = [];
    return out;
  }
  const last = log.entries[log.entries.length - 1];
  out.witnessed = !!last.witnessList && last.witnessed;
  return out;
}

export const latestVersion = (h: SignerHistory): SignerVersion | undefined => h.versions[h.versions.length - 1];

/** Find a verification method embedded in a DID document. */
function embeddedMethod(document: JsonObject, id: string): JsonObject | undefined {
  const vms = Array.isArray(document.verificationMethod) ? document.verificationMethod : [];
  const found = vms.find((v) => isJsonObject(v) && v.id === id);
  if (found) return found as JsonObject;
  const am = Array.isArray(document.assertionMethod) ? document.assertionMethod : [];
  return am.find((v) => isJsonObject(v) && v.id === id) as JsonObject | undefined;
}

function listedUnderAssertion(document: JsonObject, id: string): boolean {
  const am = Array.isArray(document.assertionMethod) ? document.assertionMethod : [];
  return am.some((v) => v === id || (isJsonObject(v) && v.id === id));
}

/** Whether a DID document lists, under assertionMethod, a method with this key (P7.9, P7.19). */
export function listsKey(document: JsonObject, publicKeyMultibase: string): boolean {
  const am = Array.isArray(document.assertionMethod) ? document.assertionMethod : [];
  return am.some((v) => {
    const vm = typeof v === "string" ? embeddedMethod(document, v) : isJsonObject(v) ? v : undefined;
    return !!vm && vm.publicKeyMultibase === publicKeyMultibase;
  });
}

export type VersionLookup =
  | { found: SignerVersion }
  /**
   * No log that verifies holds the named version: missing evidence, never a rejection (P5.6, P9.33). `history`
   * when no supplied log of the DID verifies; `version` when logs verify but none holds that versionId,
   * because they end before it or hold another versionId at that number, a fork of the signer's log.
   */
  | { missing: "history" | "version" }
  /** The named versionId cannot name any version: no version number, or one above P14.13's limit. */
  | { mismatch: string };

/**
 * The named version of a did:vh or did:webvh signer, from the union of the supplied logs that verify
 * (owner decision B, 22 November 2026): found if any of them holds it, whatever the others hold, so the
 * result does not depend on which logs are supplied beside it or in what order.
 */
export function lookupVersion(histories: readonly SignerHistory[], versionId: string): VersionLookup {
  const usable = histories.filter((h) => !h.failure && h.versions.length > 0);
  for (const h of usable) {
    const found = h.versions.find((v) => v.versionId === versionId);
    if (found) return { found };
  }
  const m = /^([1-9]\d*)-/.exec(versionId);
  if (!m) return { mismatch: "the named versionId has no version number" };
  if (Number(m[1]) > OG_LIMITS.signerVersions) return { mismatch: "the named version is above the P14.13 limit" };
  return { missing: usable.length ? "version" : "history" };
}

/** Compare strings by Unicode code point, for the report's deterministic tie-breaks. */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * The signer binding of one entry (P5.2, P5.3, P14.8): the verification
 * method its signer reference names, at the version it names, embedded in
 * that document, listed under assertionMethod, a Multikey with an Ed25519
 * key, in the namespace of and controlled by the document's id, not an
 * updateKey of the DID's own log, and verifying the entry's one proof.
 * Throws an OgRuleError when the binding fails. Returns the key.
 */
export function checkBinding(entry: OgEntry, ref: SignerRef, version: SignerVersion): string {
  const proof = entry.proof[0] as unknown as DataIntegrityProof;
  if (proof.verificationMethod !== ref.verificationMethod) reject("P5.2", "PROOF_METHOD", "the proof's verificationMethod is not the signer reference's (P14.8)", "author-binding");
  const doc = version.document;
  const docId = typeof doc.id === "string" ? doc.id : "";
  if (!ref.verificationMethod.startsWith(`${docId}#`)) reject("P5.3", "METHOD_NAMESPACE", "the verification method is not in the namespace of the document's id at that version", "author-binding");
  const vm = embeddedMethod(doc, ref.verificationMethod);
  if (!vm) reject("P5.3", "METHOD_NOT_EMBEDDED", "the verification method is not embedded in the signer's DID document at that version", "author-binding");
  if (!listedUnderAssertion(doc, ref.verificationMethod)) reject("P5.3", "NOT_ASSERTION", "the verification method is not listed under assertionMethod", "author-binding");
  if (vm.controller !== docId) reject("P5.3", "METHOD_CONTROLLER", "the verification method's controller is not the document's id", "author-binding");
  if (vm.type !== "Multikey" || typeof vm.publicKeyMultibase !== "string") reject("P5.3", "METHOD_TYPE", "the verification method is not a Multikey with publicKeyMultibase", "author-binding");
  let type: string;
  try {
    type = decodeMultikey(vm.publicKeyMultibase).type;
  } catch {
    return reject("P14.8", "KEY_INVALID", "the key is not an Ed25519 Multikey of 32 bytes", "author-binding");
  }
  if (type !== "Ed25519") reject("P14.8", "KEY_TYPE", "the key is not Ed25519 (P5.12)", "author-binding");
  if (version.updateKeys.includes(vm.publicKeyMultibase)) reject("P5.3", "UPDATE_KEY", "the key is an updateKey of the signer DID's own log", "author-binding");
  let ok = false;
  try {
    const { proof: _p, ...document } = entry;
    ok = verifyProof(document, proof, vm.publicKeyMultibase);
  } catch {
    ok = false;
  }
  if (!ok) reject("P5.3", "PROOF_INVALID", "the proof does not verify with the key (P14.8)", "author-binding");
  return vm.publicKeyMultibase;
}
