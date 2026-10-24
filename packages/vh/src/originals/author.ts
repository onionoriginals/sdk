/**
 * Author DID histories and the author binding of each entry (P5.2, P5.3,
 * P5.8, P5.11). Author keys are ordinary assertionMethod verification methods
 * of the author DID (P5.3; owner decision Q6, plan 011 S8).
 *
 * Identity continuity (P5.14): the identity is the DID the signed state names.
 * Its history is the identity DID's own log, verified from genesis, with the
 * same SCID. A did:webvh can move under the method's portability rules (the
 * did:webvh specialisation enforces them: `portable` at genesis and the prior
 * DID in `alsoKnownAs`), after which its document `id` changes; P5.3 is then
 * checked against the `id` at the version an entry names. `alsoKnownAs`,
 * redirects, another SCID or another DID method never make two DIDs one
 * identity. Histories are looked up by the identity DID.
 */
import { decodeMultikey } from "../crypto/index.js";
import { OriginalsError, fail } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { parseLog, verifyLog, type LogFailure } from "../log/index.js";
import { didVh } from "../didvh/index.js";
import { didWebvh, parseDidWebvh } from "../webvh/index.js";
import { ORIGINALS_LIMITS, type AuthorRef } from "./state.js";
import { chainOrder, parseBtcoAlias, readSat, type ChainPosition, type SatEvidence, type SatInscription } from "./btco.js";
import { decodeCbor } from "./cbor.js";

/** The author DID methods the baseline profile lists (P5.8). did:btco arrives with Bitcoin (plan 011, PR 9). */
export type AuthorMethod = "did:vh" | "did:webvh" | "did:btco";

export function authorMethod(did: string): AuthorMethod {
  for (const method of ["did:vh", "did:webvh", "did:btco"] as const) if (did.startsWith(`${method}:`)) return method;
  return fail("unsupported-profile", "AUTHOR_METHOD_NOT_LISTED", `author DID ${did} uses a method the profile does not list`);
}

/**
 * The author DID's history, as supplied in evidence: the log and witness file
 * of a did:vh or did:webvh, or what an adapter read from a did:btco's sat
 * (P5.13).
 */
export interface AuthorDidEvidence {
  /** The identity DID: the DID the asset log's signed state names (P5.14). */
  did: string;
  log?: string | unknown[];
  witness?: unknown;
  /**
   * PROVISIONAL (P5.14, P7.8): the URL this log was just retrieved from, with
   * no redirects. When it is where the latest entry that this identity signed
   * says the DID is (the DID of that entry's verification method id), the
   * identity's freshness is reported as `retrieved`. Set by the retriever,
   * never taken from a package.
   */
  retrievedFrom?: string;
  /**
   * When this history was obtained (ISO 8601), and from where. A report on an
   * unanchored Original states both for each signer DID it relied on, because
   * it is valid only as of that evidence (P7.10). Absent means the supplier did
   * not say, and the report says null rather than guess.
   */
  obtainedAt?: string;
  source?: EvidenceSource;
  /** For a did:btco: one read of the DID's sat per Bitcoin index used; their placement is compared (P9.10). */
  bitcoin?: SatEvidence | SatEvidence[];
}

/**
 * Where a signer DID history came from: an evidence package, a host's
 * snapshot, a retrieval from the DID's location (P5.14), a verifier's own
 * store of evidence verified before (P7.8), or the caller.
 */
export type EvidenceSource = "package" | "host" | "fetched" | "retained" | "supplied";

export interface AuthorVersion {
  versionId: string;
  versionNumber: number;
  /** versionTime in epoch milliseconds. */
  time: number;
  document: JsonObject;
  /** The author DID log's update keys in effect after this version. */
  updateKeys: string[];
  deactivated: boolean;
  /** A did:btco version's chain position (P5.13). */
  position?: ChainPosition;
}

export interface AuthorHistory {
  did: string;
  method: AuthorMethod;
  /** The verified versions, oldest first. */
  versions: AuthorVersion[];
  /** Why verification stopped before the end of the supplied log, if it did. */
  failure?: LogFailure;
  /**
   * did:btco only: the chain position before which the history is
   * established, the block after the lowest tip read or the first inscription
   * whose placement the indexes dispute. Absent once deactivated, which is
   * terminal (P5.13, P9.15).
   */
  establishedBefore?: ChainPosition;
}

export interface AuthorHistoryOptions {
  now?: number | Date;
  maxVersions?: number;
}

/** Verify a did:vh or did:webvh author DID log. Invalid trailing entries are dropped and reported. */
export async function verifyAuthorHistory(evidence: AuthorDidEvidence, options: AuthorHistoryOptions = {}): Promise<AuthorHistory> {
  const method = authorMethod(evidence.did);
  if (method === "did:btco") return btcoHistory(evidence, options);
  let entries: unknown[];
  try {
    if (evidence.log === undefined) fail("incomplete-evidence", "AUTHOR_HISTORY_MISSING", `no log for author DID ${evidence.did}`);
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
  // P5.14: the log is the identity DID's own only if it verifies from genesis (verifyLog), has the
  // identity DID's SCID and, for did:webvh, the identity DID is one of its versions' ids, reached
  // through moves the method accepts (the did:webvh specialisation). A log with another SCID that
  // lists the identity in alsoKnownAs is someone else's.
  const scidOk = method === "did:vh" ? log.scid === evidence.did.slice("did:vh:".length) : webvhScid(evidence.did) === log.scid && versions.some((v) => v.document.id === evidence.did);
  if (versions.length > 0 && !scidOk) {
    return { did: evidence.did, method, versions: [], failure: { index: 0, error: new OriginalsError("invalid-evidence", "AUTHOR_LOG_MISMATCH", "the supplied log is not this DID's own log from its genesis (P5.14)") } };
  }
  return { did: evidence.did, method, versions, ...(log.failure ? { failure: log.failure } : {}) };
}

/**
 * A did:btco author DID's versions, from its sat (P5.13; did:btco method
 * v0.2.0, owner decision Q15). A version is a confirmed inscription that every
 * index read reports on the sat number the DID names, on the DID's network
 * (P9.10; the label a read is supplied under does not count), whose metadata
 * is a CBOR DID document with this DID as its `id`, in chain order. A
 * document with `deactivated: true` is terminal, even as the first: later
 * inscriptions on the sat are not versions. Control is the sat's holder, so
 * there are no update keys. An entry names a version by its inscription id
 * (PROVISIONAL). Where the indexes disagree on an inscription's placement, it
 * and everything after it are undecided: the history stops before it and
 * reports missing evidence (P9.10).
 */
function btcoHistory(evidence: AuthorDidEvidence, options: AuthorHistoryOptions): AuthorHistory {
  const did = evidence.did;
  const failed = (category: "incomplete-evidence" | "invalid-evidence", code: string, message: string): AuthorHistory =>
    ({ did, method: "did:btco", versions: [], failure: { index: 0, error: new OriginalsError(category, code, message) } });
  let alias;
  try {
    alias = parseBtcoAlias(did);
  } catch {
    return failed("invalid-evidence", "AUTHOR_DID_INVALID", `${did} is not a did:btco`);
  }
  const reads = evidence.bitcoin === undefined ? [] : Array.isArray(evidence.bitcoin) ? evidence.bitcoin : [evidence.bitcoin];
  if (reads.length === 0) return failed("incomplete-evidence", "AUTHOR_BITCOIN_EVIDENCE_MISSING", `no Bitcoin read of ${did}'s sat`);
  const mislabelled = reads.find((r) => r.sat !== alias.did);
  if (mislabelled) return failed("invalid-evidence", "AUTHOR_LOG_MISMATCH", `the sat read is ${mislabelled.sat}, not ${did}`);
  const read = readSat(alias.did, reads);
  const versions: AuthorVersion[] = [];
  const max = options.maxVersions ?? ORIGINALS_LIMITS.authorVersions;
  let unread: SatInscription | undefined;
  for (const i of read.inscriptions) {
    if (i.confirmations < 1) continue;
    // Metadata not read could hold a version: the history stops before it, never skips it (M1).
    // A delegated or encoded inscription carries its own metadata, which delegation and body
    // encoding do not affect, so it is a version candidate like any other; metadata the reader
    // did not establish for it (absent, not null) fails closed. Whether such an inscription
    // counts as a did:btco version is open in P5.13: PROVISIONAL.
    if (i.unsupported === "not-read" || (i.unsupported && i.metadata === undefined)) {
      unread = i;
      break;
    }
    if (!i.metadata) continue;
    let doc;
    try {
      doc = decodeCbor(i.metadata);
    } catch (error) {
      if (error instanceof OriginalsError) continue;
      throw error;
    }
    if (!isJsonObject(doc) || doc.id !== did) continue;
    const position = { height: i.height, transactionIndex: i.transactionIndex, inscriptionIndex: i.inscriptionIndex };
    const deactivated = doc.deactivated === true;
    const previous = versions[versions.length - 1];
    versions.push({
      versionId: i.id,
      versionNumber: versions.length + 1,
      time: i.inscriptionTime,
      document: deactivated && previous ? previous.document : doc,
      updateKeys: [],
      deactivated,
      position,
    });
    // Deactivation is terminal: the state is settled at every later position.
    if (deactivated) return { did, method: "did:btco", versions };
    if (versions.length > max) return failed("invalid-evidence", "AUTHOR_HISTORY_TOO_LONG", `${did} has more than ${max} versions`);
  }
  // Established through the lowest tip read, and only before the first disputed placement (P9.10, P9.15).
  const disputed = new Set(read.disputed);
  const firstDisputed = reads.flatMap((r) => r.inscriptions).filter((i) => disputed.has(i.id)).sort(chainOrder)[0];
  const afterTip: ChainPosition = { height: read.tip.height + 1, transactionIndex: 0, inscriptionIndex: 0 };
  const establishedBefore = unread ? positionOf(unread) : firstDisputed && chainOrder(firstDisputed, afterTip) < 0 ? positionOf(firstDisputed) : afterTip;
  if (unread) {
    const error = new OriginalsError("incomplete-evidence", "AUTHOR_SAT_READ_INCOMPLETE", `inscription ${unread.id} on ${did}'s sat was not read in full: it could be a version (P5.13)`);
    return { did, method: "did:btco", versions, establishedBefore, failure: { index: versions.length, error } };
  }
  if (firstDisputed) {
    const error = new OriginalsError("incomplete-evidence", "AUTHOR_PLACEMENT_DISPUTED", `the indexes used disagree on whether inscription ${firstDisputed.id} is on ${did}'s sat (P9.10)`);
    return { did, method: "did:btco", versions, establishedBefore, failure: { index: versions.length, error } };
  }
  if (versions.length === 0) return failed("incomplete-evidence", "AUTHOR_DID_NOT_FOUND", `no DID document is inscribed on ${did}'s sat`);
  return { did, method: "did:btco", versions, establishedBefore };
}

const positionOf = (p: ChainPosition): ChainPosition => ({ height: p.height, transactionIndex: p.transactionIndex, inscriptionIndex: p.inscriptionIndex });

function webvhScid(did: string): string | undefined {
  try {
    return parseDidWebvh(did).scid;
  } catch {
    return undefined;
  }
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
    fail("incomplete-evidence", "AUTHOR_VERSION_UNAVAILABLE", `DID version ${ref.versionId} is not in the verified history of ${ref.did}`, { did: ref.did });
  }
  return version;
}

/** The `id` of the DID document at `version`: the identity DID, or where a did:webvh has moved (P5.14). */
export function documentId(version: AuthorVersion): string {
  const id = version.document.id;
  if (typeof id !== "string") binding("AUTHOR_DOCUMENT_ID", "the author DID document at that version has no id");
  return id;
}

/**
 * P5.3: the Multikey that verifies an entry by `ref`. The verification method
 * must be embedded in the author DID document at the named version, listed
 * under assertionMethod, of type Multikey, and not an update key of the author
 * DID's own log (P5.11). Its id must be in the namespace of, and its
 * controller must equal, that document's `id`: the identity DID, or after a
 * did:webvh move the DID it now lives at (P5.14). Another document's methods
 * and the document's `controller` property confer nothing.
 */
export function authorKey(version: AuthorVersion, ref: AuthorRef): string {
  const doc = version.document;
  const docId = documentId(version);
  if (!ref.verificationMethod.startsWith(`${docId}#`)) binding("AUTHOR_VM_FOREIGN", "the verification method is not in the namespace of the author DID document's id at that version (P5.3, P5.14)");
  const vm = embedded(doc, ref.verificationMethod, docId);
  if (!vm) binding("AUTHOR_VM_NOT_IN_DOCUMENT", "the verification method is not embedded in the author DID document at that version");
  const assertion = Array.isArray(doc.assertionMethod) ? doc.assertionMethod : [];
  const listed = assertion.some((item) => sameId(item, ref.verificationMethod, docId) || (isJsonObject(item) && sameId(item.id, ref.verificationMethod, docId)));
  if (!listed) binding("AUTHOR_VM_RELATIONSHIP", "the verification method is not listed under assertionMethod");
  if (vm.type !== "Multikey") binding("AUTHOR_VM_TYPE", "the verification method must have type Multikey");
  if (vm.controller !== docId) binding("AUTHOR_VM_CONTROLLER", "the verification method's controller must be the author DID document's id at that version (P5.3, P5.14)");
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

function embedded(doc: JsonObject, id: string, docId: string): JsonObject | undefined {
  for (const list of [doc.verificationMethod, doc.assertionMethod]) {
    const found = Array.isArray(list) ? list.filter(isJsonObject).find((vm) => sameId(vm.id, id, docId)) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * True when `version` lists `publicKeyMultibase` as an author key that meets
 * P5.3 there, under whatever id it now has (for P7.9: a key kept across a
 * did:webvh move is still listed).
 */
export function stillAuthorized(version: AuthorVersion, _ref: AuthorRef, publicKeyMultibase: string): boolean {
  const docId = typeof version.document.id === "string" ? version.document.id : undefined;
  if (!docId) return false;
  const assertion = Array.isArray(version.document.assertionMethod) ? version.document.assertionMethod : [];
  const ids = assertion.flatMap((item) => (typeof item === "string" ? [item] : isJsonObject(item) && typeof item.id === "string" ? [item.id] : []));
  return ids.some((id) => {
    const absolute = id.startsWith("#") ? `${docId}${id}` : id;
    try {
      return authorKey(version, { did: docId, verificationMethod: absolute, versionId: version.versionId }) === publicKeyMultibase;
    } catch (error) {
      if (error instanceof OriginalsError) return false;
      throw error;
    }
  });
}

/**
 * Where the DID lived when the entry naming `ref` was signed: the DID of its
 * verification method id. A verifier finds a moved identity's log there
 * (P5.14), without following redirects (P8.5).
 */
export function signerLocation(ref: AuthorRef): string {
  const hash = ref.verificationMethod.indexOf("#");
  return hash < 0 ? ref.verificationMethod : ref.verificationMethod.slice(0, hash);
}
