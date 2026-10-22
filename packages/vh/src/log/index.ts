/**
 * A generic VH-Log engine (swcurran/VH-Log@f2f9fda with PRs 2, 3, 8, 9, 10 and
 * 11 treated as merged). It implements the log mechanism only; every rule that
 * VH-Log leaves to a specialisation comes from a `Specialisation`.
 *
 * Verification follows VH-Log "Read (Resolve)": every entry is fully checked,
 * the first failure ends the valid prefix, and a failing first entry
 * invalidates the log. Witness proofs are checked only after every non-witness
 * check has passed, and an entry without a threshold of approvals also ends
 * the valid prefix.
 *
 * Comparing copies, retained versionIds and minCopies are in `resolveCopies`.
 * Not here yet, by design: retrieval (plan 011, PR 7), authoritative sources
 * and alternative encodings (PR 9).
 */
import {
  CRYPTOSUITES,
  base58btcDecode,
  base58btcEncode,
  createProof,
  decodeMultikey,
  decodeSha256Multihash,
  didKeyMultikey,
  isCryptosuite,
  sha256Multihash,
  verifyProof,
  type CryptosuiteName,
  type DataIntegrityProof,
  type ProofSigner,
} from "../crypto/index.js";
import { OriginalsError, fail, type ErrorCategory } from "../errors.js";
import { canonicalBytes, canonicalize, isJsonObject, parseJson, parseJsonLines, type JsonObject, type JsonValue, type ParseLimits } from "../json/index.js";

// ---------------------------------------------------------------------------
// Types

export interface LogEntry {
  versionId: string;
  versionTime: string;
  parameters: JsonObject;
  state: JsonObject;
  proof: DataIntegrityProof[];
}

export interface WitnessEntry {
  id: string;
}

/** An active witness list. `{}` (no witnesses) is represented as `null` in `WitnessList`. */
export interface WitnessList {
  threshold: number;
  witnesses: WitnessEntry[];
}

export interface WitnessFileEntry {
  versionId: string;
  proof: DataIntegrityProof[];
}

/** One value of a specialisation's version parameter (VH-Log, `logVersion`). */
export interface VersionRules {
  /** The VH-Log version this value implies. */
  vhLog: "vh-log:1.0";
  /** Ordering among values; a log may not move to a lower rank. */
  rank: number;
  /** Cryptosuites permitted for log-entry proofs (VH-Log PR 3). */
  entrySuites: CryptosuiteName[];
  /** Cryptosuites permitted for witness proofs (VH-Log PR 3). */
  witnessSuites: CryptosuiteName[];
}

export interface EntryContext {
  /** Zero-based position in the log. */
  index: number;
  entry: LogEntry;
  /** The verified predecessor, absent for the first entry. */
  previous?: VerifiedEntry;
  scid: string;
  /** Parameters in effect after this entry. */
  active: ActiveParameters;
  version: VersionRules;
}

/** VH-Log PR 11: authorized keys come from a controller with its own history. */
export interface ControllerKeys {
  kind: "controller";
  /**
   * Return the Multikey that may verify `proof` for this entry, or reject with
   * an `OriginalsError` (for example `unauthorized-key`, `author-binding` or
   * `incomplete-evidence`). It must never fall back to trusting the proof's key.
   */
  authorize(context: EntryContext & { proof: DataIntegrityProof }): Promise<string>;
}

export interface Specialisation {
  name: string;
  /** The designated version parameter, such as did:vh's `method`, or `logVersion`. */
  versionParameter: string;
  versions: Readonly<Record<string, VersionRules>>;
  /**
   * Parameters the specialisation defines, with validators returning false for a
   * non-conformant value. Every parameter outside VH-Log's and these is rejected.
   */
  extraParameters?: Readonly<Record<string, (value: JsonValue) => boolean>>;
  /** VH-Log PR 8: fractional-second precision (at most 3 digits) and a minimum interval. */
  versionTime?: { fractionalDigits?: number; minIntervalSeconds?: number };
  /** Maximum proofs per entry; unlimited when absent. */
  maxProofs?: number;
  /**
   * `reject` (the default) or `ignore`, which is VH-Log's own rule for
   * parameters a resolver does not recognise. Originals and did:vh reject.
   */
  unknownParameters?: "reject" | "ignore";
  keys: { kind: "updateKeys" } | ControllerKeys;
  /** Witness identifier to Multikey. Defaults to did:key (did:vh, did:webvh). */
  witnessKey?(id: string): string;
  /** Extra checks of the state object (VH-Log Read step 6). Reject with an `OriginalsError`. */
  validateEntry?(context: EntryContext): void | Promise<void>;
}

export interface ActiveParameters {
  version: string;
  scid: string;
  updateKeys: string[];
  nextKeyHashes: string[];
  /** `{}` or a witness list. */
  witness: JsonObject;
  watchers: string[];
  deactivated: boolean;
  ttl: number;
  /** Specialisation-defined parameters, accumulated like VH-Log's. */
  extra: JsonObject;
}

export interface VerifiedEntry {
  entry: LogEntry;
  versionNumber: number;
  /** Milliseconds since the epoch. */
  time: number;
  /** Parameters in effect after this entry. */
  active: ActiveParameters;
  /** The witness list that had to approve this entry, if any. */
  witnessList: WitnessList | null;
  witnessed: boolean;
}

export interface LogFailure {
  index: number;
  versionId?: string;
  error: OriginalsError;
}

export interface LogVerification {
  /** The SCID, or null when the first entry is invalid. */
  scid: string | null;
  /** The valid prefix. */
  entries: VerifiedEntry[];
  /** Parameters in effect after the last valid entry. */
  active: ActiveParameters | null;
  deactivated: boolean;
  failure?: LogFailure;
}

export interface LogLimits {
  maxEntries?: number;
  /**
   * Maximum size of one entry: the UTF-8 byte length of its stored line,
   * without the line feed (P7.7; P14.13, PROVISIONAL originals-spec #48
   * 1f90e43bc). A log's text is measured line by line as stored, before it is
   * parsed, and so is each entry `verifyLog` is given with its stored size
   * (`lineBytes`) or that `parseLog` parsed. An entry with no stored line
   * (built or parsed elsewhere) is measured as its JCS serialization, the
   * line a conforming writer stores (PROVISIONAL).
   */
  maxEntryBytes?: number;
}

const utf8 = new TextEncoder();

/** The UTF-8 byte length of `text`. */
export function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

export interface VerifyOptions {
  specialisation: Specialisation;
  /** The witness proofs file content, if any. */
  witnessFile?: unknown;
  /** The resolver's current time; defaults to now. */
  now?: number | Date;
  /** Future-dating tolerance; VH-Log recommends at most 5 minutes. */
  futureToleranceSeconds?: number;
  limits?: LogLimits;
}

export const SCID_PLACEHOLDER = "{SCID}";

// ---------------------------------------------------------------------------
// Hashes

/** `base58btc(multihash(JCS(value), sha2-256))`, the VH-Log hash form. */
export function vhHash(value: JsonValue): string {
  return base58btcEncode(sha256Multihash(canonicalBytes(value)));
}

/** VH-Log pre-rotation hash of a Multikey: `base58btc(multihash(multikey))`. */
export function keyHash(multikey: string): string {
  return base58btcEncode(sha256Multihash(new TextEncoder().encode(multikey)));
}

function requireVhHash(value: string, code: string): void {
  decodeSha256Multihash(base58btcDecode(value));
  if (base58btcEncode(base58btcDecode(value)) !== value) fail("invalid-evidence", code, "hash is not canonical base58btc");
}

function withoutProof(entry: LogEntry): JsonObject {
  const { proof: _proof, ...rest } = entry;
  return rest;
}

function replaceText(value: JsonValue, from: string, to: string): JsonValue {
  return parseJson(JSON.stringify(value).split(from).join(to));
}

/** VH-Log SCID generation over a preliminary entry with `{SCID}` placeholders. */
export function computeScid(preliminary: JsonObject): string {
  return vhHash({ ...preliminary, versionId: SCID_PLACEHOLDER });
}

// ---------------------------------------------------------------------------
// Parameter validation

const VH_PARAMETERS = new Set(["scid", "updateKeys", "nextKeyHashes", "witness", "watchers", "deactivated", "ttl"]);

function invalidParameter(name: string, message: string): never {
  throw new OriginalsError("invalid-evidence", "PARAMETER_INVALID", `parameter ${name}: ${message}`);
}

function isStringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function defaultWitnessKey(id: string): string {
  const match = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(id);
  if (!match) invalidParameter("witness", `witness id ${JSON.stringify(id)} is not a did:key DID`);
  return didKeyMultikey(`${id}#${match[1]}`);
}

function validateWitness(value: JsonValue, spec: Specialisation, version: VersionRules): void {
  if (!isJsonObject(value)) invalidParameter("witness", "must be an object");
  const keys = Object.keys(value);
  if (keys.length === 0) return;
  if (keys.some((key) => key !== "threshold" && key !== "witnesses")) invalidParameter("witness", "has undefined members");
  const { threshold, witnesses } = value;
  if (!Array.isArray(witnesses) || witnesses.length === 0) invalidParameter("witness", "witnesses must be a non-empty array");
  const ids = new Set<string>();
  for (const witness of witnesses) {
    if (!isJsonObject(witness) || Object.keys(witness).length !== 1 || typeof witness.id !== "string") {
      invalidParameter("witness", "each witness must be exactly { id }");
    }
    const id = witness.id.normalize("NFC");
    if (ids.has(id)) invalidParameter("witness", `witness ${id} is listed twice`);
    ids.add(id);
    const multikey = (spec.witnessKey ?? defaultWitnessKey)(witness.id);
    const keyType = decodeMultikey(multikey).type;
    if (!version.witnessSuites.some((suite) => CRYPTOSUITES[suite] === keyType)) {
      invalidParameter("witness", `witness ${id} has a key no permitted witness cryptosuite uses`);
    }
  }
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1 || threshold > ids.size) {
    invalidParameter("witness", "threshold must be an integer between 1 and the number of distinct witnesses");
  }
}

/**
 * VH-Log lists watchers as URLs. This applies the syntactic rule pinned by
 * vh-log-interop-0: printable ASCII, an http or https scheme and a non-empty
 * authority. Retrieval applies its own, stricter rules (P8.5).
 */
function isWatcherUrl(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && /^https?:\/\/[^/?#]/.test(value);
}

/** Run a parameter check, reporting any failure inside it as PARAMETER_INVALID. */
function asParameterError<T>(name: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof OriginalsError && error.code !== "PARAMETER_INVALID") {
      throw new OriginalsError("invalid-evidence", "PARAMETER_INVALID", `parameter ${name}: ${error.message}`);
    }
    throw error;
  }
}

function applyParameters(
  parameters: JsonObject,
  previous: ActiveParameters | undefined,
  spec: Specialisation,
): { active: ActiveParameters; version: VersionRules } {
  const first = previous === undefined;
  const controller = spec.keys.kind === "controller";
  for (const [name, value] of Object.entries(parameters)) {
    if (value === null) fail("invalid-evidence", "PARAMETER_NULL", `parameter ${name} is null`);
    const known = name === spec.versionParameter || VH_PARAMETERS.has(name) || (spec.extraParameters && Object.prototype.hasOwnProperty.call(spec.extraParameters, name));
    if (!known && (spec.unknownParameters !== "ignore" || name === "logVersion")) {
      fail("invalid-evidence", "PARAMETER_UNKNOWN", `parameter ${name} is not defined by VH-Log or ${spec.name}`);
    }
    if (controller && (name === "updateKeys" || name === "nextKeyHashes")) {
      fail("invalid-evidence", "PARAMETER_FORBIDDEN", `${name} must not be set in a log whose keys come from a controller`);
    }
  }

  // Version parameter.
  const versionValue = parameters[spec.versionParameter];
  if (first && versionValue === undefined) fail("unsupported-profile", "VERSION_MISSING", `the first entry must set ${spec.versionParameter}`);
  if (versionValue !== undefined) {
    if (typeof versionValue !== "string" || !Object.prototype.hasOwnProperty.call(spec.versions, versionValue)) {
      fail("unsupported-profile", "VERSION_UNSUPPORTED", `${spec.versionParameter} ${JSON.stringify(versionValue)} is not supported`);
    }
    if (previous && spec.versions[versionValue].rank < spec.versions[previous.version].rank) {
      fail("invalid-evidence", "VERSION_DOWNGRADE", `${spec.versionParameter} may not move to a lower version`);
    }
  }
  const versionName = (versionValue as string | undefined) ?? previous!.version;
  const version = spec.versions[versionName];

  // scid.
  if (first) {
    if (typeof parameters.scid !== "string") fail("invalid-evidence", "PARAMETER_REQUIRED", "the first entry must set scid");
  } else if (parameters.scid !== undefined) {
    fail("invalid-evidence", "PARAMETER_SCID", "scid may appear only in the first entry");
  }

  // Keys.
  if (parameters.updateKeys !== undefined) {
    if (!isStringArray(parameters.updateKeys)) invalidParameter("updateKeys", "must be an array of Multikeys");
    for (const key of parameters.updateKeys) {
      const type = asParameterError("updateKeys", () => decodeMultikey(key).type);
      if (!version.entrySuites.some((suite) => CRYPTOSUITES[suite] === type)) {
        invalidParameter("updateKeys", `key ${key} has a type no permitted cryptosuite uses`);
      }
    }
  } else if (first && !controller) {
    fail("invalid-evidence", "PARAMETER_REQUIRED", "the first entry must set updateKeys");
  }
  if (parameters.nextKeyHashes !== undefined) {
    if (!isStringArray(parameters.nextKeyHashes)) invalidParameter("nextKeyHashes", "must be an array of hashes");
    for (const hash of parameters.nextKeyHashes) asParameterError("nextKeyHashes", () => requireVhHash(hash, "PARAMETER_INVALID"));
  }

  if (parameters.witness !== undefined) asParameterError("witness", () => validateWitness(parameters.witness, spec, version));
  if (parameters.watchers !== undefined) {
    if (!isStringArray(parameters.watchers) || !parameters.watchers.every(isWatcherUrl)) {
      invalidParameter("watchers", "must be an array of http(s) URLs");
    }
  }
  if (parameters.deactivated !== undefined && typeof parameters.deactivated !== "boolean") invalidParameter("deactivated", "must be a boolean");
  if (parameters.ttl !== undefined) {
    const ttl = parameters.ttl;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 2 ** 31) invalidParameter("ttl", "must be an integer from 0 to 2^31");
  }
  const extra: JsonObject = { ...(previous?.extra ?? {}) };
  for (const [name, validate] of Object.entries(spec.extraParameters ?? {})) {
    if (parameters[name] === undefined) continue;
    if (!validate(parameters[name])) invalidParameter(name, `value is not permitted by ${spec.name}`);
    extra[name] = parameters[name];
  }

  return {
    version,
    active: {
      version: versionName,
      scid: previous?.scid ?? (parameters.scid),
      updateKeys: (parameters.updateKeys) ?? previous?.updateKeys ?? [],
      nextKeyHashes: (parameters.nextKeyHashes) ?? previous?.nextKeyHashes ?? [],
      witness: (parameters.witness as JsonObject | undefined) ?? previous?.witness ?? {},
      watchers: (parameters.watchers) ?? previous?.watchers ?? [],
      deactivated: (parameters.deactivated) ?? false,
      ttl: (parameters.ttl as number | undefined) ?? previous?.ttl ?? 3600,
      extra,
    },
  };
}

function witnessListOf(value: JsonObject): WitnessList | null {
  return Object.keys(value).length === 0 ? null : (value as unknown as WitnessList);
}

// ---------------------------------------------------------------------------
// versionTime

const VERSION_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|\+00:00)$/;

/** Parse a VH-Log versionTime to epoch milliseconds, or throw VERSION_TIME_FORMAT. */
export function parseVersionTime(value: unknown, fractionalDigits = 0): number {
  const match = typeof value === "string" ? VERSION_TIME.exec(value) : null;
  const bad = () => fail("invalid-evidence", "VERSION_TIME_FORMAT", `versionTime ${JSON.stringify(value)} is not a UTC ISO 8601 time at the permitted precision`);
  if (!match) return bad();
  const [, y, mo, d, h, mi, s, fraction] = match;
  if (fraction !== undefined && fraction.length > Math.min(fractionalDigits, 3)) return bad();
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(+y, +mo - 1, +d);
  date.setUTCHours(+h, +mi, +s, fraction ? Number(fraction.padEnd(3, "0")) : 0);
  const time = date.getTime();
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || date.getUTCHours() !== +h || date.getUTCMinutes() !== +mi || date.getUTCSeconds() !== +s) {
    return bad();
  }
  return time;
}

// ---------------------------------------------------------------------------
// Entry structure

const ENTRY_MEMBERS = ["versionId", "versionTime", "parameters", "state", "proof"];
const VERSION_ID = /^([1-9]\d*)-([1-9A-HJ-NP-Za-km-z]+)$/;

function checkStructure(raw: unknown, limits: LogLimits, storedBytes: number | undefined): LogEntry {
  if (!isJsonObject(raw)) fail("invalid-evidence", "LOG_LINE_INVALID", "a log line must be a JSON object");
  const keys = Object.keys(raw);
  if (keys.length !== ENTRY_MEMBERS.length || !ENTRY_MEMBERS.every((key) => keys.includes(key))) {
    fail("invalid-evidence", "ENTRY_MEMBERS", "a log entry has exactly versionId, versionTime, parameters, state and proof");
  }
  if (typeof raw.versionId !== "string" || typeof raw.versionTime !== "string") {
    fail("invalid-evidence", "ENTRY_MEMBERS", "versionId and versionTime must be strings");
  }
  if (!isJsonObject(raw.parameters) || !isJsonObject(raw.state)) fail("invalid-evidence", "ENTRY_MEMBERS", "parameters and state must be objects");
  if (!Array.isArray(raw.proof)) fail("invalid-evidence", "ENTRY_MEMBERS", "proof must be an array");
  // P14.13: the stored line when there is one, else the JCS line a writer stores (PROVISIONAL).
  if (limits.maxEntryBytes !== undefined && (storedBytes ?? storedLineBytes.get(raw) ?? utf8Length(canonicalize(raw))) > limits.maxEntryBytes) {
    fail("limit-exceeded", "ENTRY_TOO_LARGE", `entry exceeds ${limits.maxEntryBytes} bytes`);
  }
  return raw as unknown as LogEntry;
}

// ---------------------------------------------------------------------------
// Verification

async function verifyEntry(
  index: number,
  raw: unknown,
  previous: VerifiedEntry | undefined,
  options: VerifyOptions,
  now: number,
  storedBytes?: number,
): Promise<VerifiedEntry> {
  const spec = options.specialisation;
  // Checks run in VH-Log's step order, as vh-log-interop-0 section 4 pins it, so
  // the first failing check names the error: deactivation, structure,
  // parameters (with pre-rotation), proofs, versionId, versionTime, SCID, state.
  if (previous?.active.deactivated) fail("deactivated", "ENTRY_AFTER_DEACTIVATION", "no entry may follow a deactivating entry");
  const entry = checkStructure(raw, options.limits ?? {}, storedBytes);

  // Parameters (VH-Log Read step 1) and pre-rotation (step 7, which concerns only parameters).
  const { active, version } = applyParameters(entry.parameters, previous?.active, spec);
  let authorizedKeys: string[] = [];
  if (spec.keys.kind === "updateKeys") {
    const prerotation = (previous?.active.nextKeyHashes.length ?? 0) > 0;
    if (prerotation) {
      if (entry.parameters.updateKeys === undefined) fail("invalid-evidence", "PREROTATION_UPDATE_KEYS", "pre-rotation requires explicit updateKeys");
      if (entry.parameters.nextKeyHashes === undefined) fail("invalid-evidence", "PREROTATION_NEXT_KEY_HASHES", "pre-rotation requires an explicit nextKeyHashes");
      for (const key of active.updateKeys) {
        if (!previous!.active.nextKeyHashes.includes(keyHash(key))) fail("unauthorized-key", "PREROTATION_KEY", `key ${key} was not committed by the previous entry`);
      }
    }
    authorizedKeys = !previous || prerotation ? active.updateKeys : previous.active.updateKeys;
  }

  // Proofs (step 2): key form, then authorization, then the proof itself.
  if (entry.proof.length === 0) fail("invalid-evidence", "PROOF_MISSING", "an entry needs a proof");
  if (spec.maxProofs !== undefined && entry.proof.length > spec.maxProofs) {
    fail("invalid-evidence", "PROOF_COUNT", `an entry may carry at most ${spec.maxProofs} proof(s)`);
  }
  const context: EntryContext = { index, entry, previous, scid: active.scid, active, version };
  const document = withoutProof(entry);
  for (const proof of entry.proof) {
    if (!isJsonObject(proof)) fail("invalid-evidence", "PROOF_INVALID", "proof must be an object");
    let key: string;
    if (spec.keys.kind === "updateKeys") {
      key = asProofError(() => didKeyMultikey(proof.verificationMethod, { fragment: "optional" }));
      if (!authorizedKeys.includes(key)) fail("unauthorized-key", "UNAUTHORIZED_KEY", `${proof.verificationMethod} is not an active update key`);
    } else {
      key = await spec.keys.authorize({ ...context, proof });
    }
    if (proof.proofPurpose !== "assertionMethod") fail("invalid-evidence", "PROOF_PURPOSE", "proofPurpose must be assertionMethod");
    if (!isCryptosuite(proof.cryptosuite) || !version.entrySuites.includes(proof.cryptosuite)) {
      fail("unsupported-profile", "CRYPTOSUITE_NOT_PERMITTED", `cryptosuite ${JSON.stringify(proof.cryptosuite)} is not permitted by ${active.version}`);
    }
    if (!asProofError(() => verifyProof(document, proof, key))) {
      fail("invalid-evidence", "PROOF_SIGNATURE", `proof by ${proof.verificationMethod} does not verify`);
    }
  }

  // versionId (step 3).
  const id = VERSION_ID.exec(entry.versionId);
  if (!id) fail("invalid-evidence", "VERSION_ID_FORMAT", "versionId must be <number>-<entry hash>");
  const versionNumber = Number(id[1]);
  if (versionNumber !== index + 1) fail("invalid-evidence", "VERSION_NUMBER", `entry ${index + 1} has version number ${versionNumber}`);
  requireVhHash(id[2], "VERSION_ID_FORMAT");
  const predecessor = previous?.entry.versionId ?? active.scid;
  if (vhHash({ ...withoutProof(entry), versionId: predecessor }) !== id[2]) {
    fail("invalid-evidence", "ENTRY_HASH_MISMATCH", `entry ${versionNumber} does not hash to its versionId`);
  }

  // versionTime (step 4).
  const time = parseVersionTime(entry.versionTime, spec.versionTime?.fractionalDigits ?? 0);
  if (previous) {
    if (time <= previous.time) fail("invalid-evidence", "VERSION_TIME_ORDER", "versionTime must be later than the previous entry's");
    const interval = (spec.versionTime?.minIntervalSeconds ?? 0) * 1000;
    if (time - previous.time < interval) fail("invalid-evidence", "VERSION_TIME_INTERVAL", "entries are closer together than the specialisation permits");
  }
  if (time > now + (options.futureToleranceSeconds ?? 300) * 1000) {
    fail("invalid-evidence", "VERSION_TIME_FUTURE", "versionTime is too far in the future");
  }

  // SCID (step 5), first entry only.
  if (index === 0) {
    const scid = active.scid;
    requireVhHash(scid, "SCID_MISMATCH");
    const preliminary = replaceText(withoutProof({ ...entry, versionId: SCID_PLACEHOLDER }), scid, SCID_PLACEHOLDER) as JsonObject;
    if (computeScid(preliminary) !== scid) fail("invalid-evidence", "SCID_MISMATCH", "the SCID does not match the first entry");
  }

  // State (step 6).
  await spec.validateEntry?.(context);

  const prior = previous ? witnessListOf(previous.active.witness) : null;
  // VH-Log: a change from {} is active immediately; a replacement or removal applies after the entry.
  const witnessList = prior ?? witnessListOf(active.witness);
  return { entry, versionNumber, time, active, witnessList, witnessed: false };
}

/** Report a malformed proof as PROOF_INVALID; keep CRYPTOSUITE_* codes. */
function asProofError<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof OriginalsError && !error.code.startsWith("CRYPTOSUITE_") && !error.code.startsWith("PROOF_")) {
      throw new OriginalsError("invalid-evidence", "PROOF_INVALID", error.message);
    }
    throw error;
  }
}

function parseWitnessFile(value: unknown): WitnessFileEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid-evidence", "WITNESS_FILE_INVALID", "the witness file must be an array");
  return value.map((item) => {
    if (!isJsonObject(item) || typeof item.versionId !== "string" || !Array.isArray(item.proof) || Object.keys(item).length !== 2) {
      fail("invalid-evidence", "WITNESS_FILE_INVALID", "each witness file entry is exactly { versionId, proof }");
    }
    return item as unknown as WitnessFileEntry;
  });
}

/** Witness ids whose proofs over `versionId` verify (VH-Log Witness Threshold Algorithm). */
function approvals(
  file: WitnessFileEntry[],
  versionIds: Set<string>,
  spec: Specialisation,
  versionOf: (versionId: string) => VersionRules,
): Map<string, Set<string>> {
  const byVersion = new Map<string, Set<string>>();
  for (const { versionId, proof } of file) {
    if (!versionIds.has(versionId)) continue; // proofs for entries not in this log are ignored
    const rules = versionOf(versionId);
    const approved = byVersion.get(versionId) ?? new Set<string>();
    for (const p of proof) {
      try {
        if (!isJsonObject(p) || p.proofPurpose !== "assertionMethod" || !isCryptosuite(p.cryptosuite) || !rules.witnessSuites.includes(p.cryptosuite)) continue;
        const multikey = didKeyMultikey(p.verificationMethod);
        const did = `did:key:${multikey}`;
        const declared = spec.witnessKey ? spec.witnessKey(did) : multikey;
        if (declared !== multikey) continue;
        if (verifyProof({ versionId }, p, multikey)) approved.add(did.normalize("NFC"));
      } catch (error) {
        if (!(error instanceof OriginalsError)) throw error;
      }
    }
    byVersion.set(versionId, approved);
  }
  return byVersion;
}

/**
 * Verify parsed log entries. `lineBytes`, when given, is the UTF-8 byte length
 * of each entry's stored line without its line feed, which the entry size
 * limit measures (P14.13); without it an entry is measured as its JCS line.
 */
export async function verifyLog(entries: unknown[], options: VerifyOptions, lineBytes?: readonly number[]): Promise<LogVerification> {
  const now = options.now === undefined ? Date.now() : typeof options.now === "number" ? options.now : options.now.getTime();
  const verified: VerifiedEntry[] = [];
  let failure: LogFailure | undefined;
  const max = options.limits?.maxEntries;

  for (let index = 0; index < entries.length; index++) {
    if (max !== undefined && index >= max) {
      failure = { index, error: new OriginalsError("limit-exceeded", "LOG_TOO_LONG", `history exceeds ${max} entries`) };
      break;
    }
    try {
      verified.push(await verifyEntry(index, entries[index], verified[index - 1], options, now, lineBytes?.[index]));
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      const raw = entries[index];
      const versionId = isJsonObject(raw) && typeof raw.versionId === "string" ? raw.versionId : undefined;
      failure = { index, versionId, error };
      break;
    }
  }

  // Witnesses, only after every non-witness check (VH-Log "Verifying Witness Proofs During Resolution").
  if (verified.some((v) => v.witnessList)) {
    let file: WitnessFileEntry[] = [];
    let malformed: OriginalsError | undefined;
    try {
      file = parseWitnessFile(options.witnessFile);
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      malformed = error;
    }
    const versionIds = new Set(verified.map((v) => v.entry.versionId));
    const rulesById = new Map(verified.map((v) => [v.entry.versionId, options.specialisation.versions[v.active.version]]));
    const byVersion = approvals(file, versionIds, options.specialisation, (id) => rulesById.get(id)!);
    for (let i = 0; i < verified.length; i++) {
      const list = verified[i].witnessList;
      if (!list) continue;
      if (malformed) {
        failure = { index: i, versionId: verified[i].entry.versionId, error: malformed };
        verified.length = i;
        break;
      }
      const listed = new Set(list.witnesses.map((w) => w.id.normalize("NFC")));
      const distinct = new Set<string>();
      for (let j = i; j < verified.length; j++) {
        for (const id of byVersion.get(verified[j].entry.versionId) ?? []) if (listed.has(id)) distinct.add(id);
      }
      if (distinct.size >= list.threshold) {
        verified[i].witnessed = true;
        continue;
      }
      failure = {
        index: i,
        versionId: verified[i].entry.versionId,
        error: new OriginalsError("invalid-evidence", "WITNESS_THRESHOLD", `entry ${i + 1} has ${distinct.size} of ${list.threshold} required witness approvals`),
      };
      verified.length = i;
      break;
    }
  }

  const last = verified[verified.length - 1];
  return {
    scid: verified.length > 0 ? verified[0].active.scid : null,
    entries: verified,
    active: last?.active ?? null,
    deactivated: last?.active.deactivated ?? false,
    failure,
  };
}

/**
 * Verify a log file's text. Lines are parsed one at a time, so a line that is
 * not strict JSON ends the valid prefix there, like any other failing entry.
 */
export async function verifyLogText(text: string, options: VerifyOptions & { parse?: ParseLimits }): Promise<LogVerification> {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = text.length === 0 ? [] : body.split("\n");
  const entries: unknown[] = [];
  const sizes: number[] = [];
  let parseFailure: LogFailure | undefined;
  for (let index = 0; index < lines.length; index++) {
    try {
      if (lines[index].length === 0) throw new OriginalsError("invalid-evidence", "JSONL_BLANK_LINE", `line ${index + 1} is empty`);
      // The stored line is what is measured (P7.7, P14.13), before it is parsed, and only it.
      const max = options.limits?.maxEntryBytes;
      // A line of at most max / 3 UTF-16 code units is at most max UTF-8 bytes: that bound is what is passed on.
      const size = max === undefined || lines[index].length <= max / 3 ? lines[index].length * 3 : utf8Length(lines[index]);
      if (max !== undefined && size > max) {
        throw new OriginalsError("limit-exceeded", "ENTRY_TOO_LARGE", `entry exceeds ${max} bytes`);
      }
      entries.push(parseJson(lines[index], options.parse));
      sizes.push(size);
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      parseFailure = { index, error };
      break;
    }
  }
  if (lines.length === 0) {
    parseFailure = { index: 0, error: new OriginalsError("invalid-evidence", "LOG_EMPTY", "the log has no entries") };
  }
  const result = await verifyLog(entries, options, sizes);
  if (!parseFailure || result.failure) return result;
  return { ...result, failure: parseFailure };
}

// ---------------------------------------------------------------------------
// Comparing copies (VH-Log "Comparing Copies of a Log" and "Resolution Options")

export interface LogCopy {
  source: string;
  /** The log file text, unless the copy could not be retrieved. */
  log?: string;
  witnessFile?: unknown;
  /** Why the copy could not be retrieved. */
  unavailable?: string;
}

export type CopyStatus = "current" | "behind" | "invalid" | "unavailable";

export interface CopyReport {
  source: string;
  versionId?: string;
  status: CopyStatus;
}

export interface ResolutionWarning {
  code: "copy-behind" | "copy-invalid" | "copy-unavailable" | "invalid-entries" | "retained-version-not-found";
  source?: string;
  message: string;
}

export interface ForkReport {
  /** The version number of the first entry at which the copies differ. */
  version: number;
  copies: Array<{ source: string; versionId: string }>;
}

export interface CopiesResolution {
  /** The verified reference copy, or null when no copy could be used. */
  reference: LogVerification | null;
  referenceSource?: string;
  copies: CopyReport[];
  warnings: ResolutionWarning[];
  fork?: ForkReport;
  /** Set when fewer than minCopies copies are current or behind. */
  insufficientCopies?: boolean;
}

interface Candidate {
  copy: LogCopy;
  /** Parsed versionIds, line by line (undefined when a line has none). */
  versionIds: Array<string | undefined>;
  verification?: LogVerification;
  status?: CopyStatus;
}

function versionIdsOf(text: string): Array<string | undefined> {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return (text.length === 0 ? [] : body.split("\n")).map((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return isJsonObject(value) && typeof value.versionId === "string" ? value.versionId : undefined;
    } catch {
      return undefined;
    }
  });
}

/**
 * Resolve from several copies of one log: the primary first, then each copy
 * in order. The first copy that passes verification in full (every entry
 * valid and witnessed) is the reference; others are compared by a single
 * versionId, and only a diverging or extending copy is verified again. Two
 * verified copies that diverge are a fork, which fails resolution for every
 * version. With a single copy and no retained versionId, partial validity is
 * kept, as in an ordinary resolution.
 */
export async function resolveCopies(
  primary: LogCopy,
  others: LogCopy[],
  options: VerifyOptions & { parse?: ParseLimits; retainedVersionId?: string; minCopies?: number },
): Promise<CopiesResolution> {
  const candidates: Candidate[] = [primary, ...others].map((copy) => ({ copy, versionIds: copy.log === undefined ? [] : versionIdsOf(copy.log) }));
  const verify = async (c: Candidate) => {
    c.verification ??= await verifyLogText(c.copy.log!, { ...options, witnessFile: c.copy.witnessFile });
    return c.verification;
  };
  const passes = (v: LogVerification) => v.failure === undefined;
  const warnings: ResolutionWarning[] = [];
  let fork: ForkReport | undefined;

  let reference: Candidate | undefined;
  for (const c of candidates) {
    if (c.copy.log === undefined) {
      c.status = "unavailable";
      continue;
    }
    if (reference) break;
    if (passes(await verify(c))) reference = c;
    else if (others.length > 0) c.status = "invalid";
  }
  if (!reference && others.length === 0 && primary.log !== undefined) {
    // One copy: ordinary resolution, with partial validity and its own failure.
    await verify(candidates[0]);
    reference = candidates[0];
  }

  const lastId = (c: Candidate) => c.versionIds[c.versionIds.length - 1];
  if (reference) {
    for (const c of candidates) {
      if (c === reference || c.status === "unavailable" || c.status === "invalid") continue;
      const ref = reference.versionIds;
      if (c.versionIds.length <= ref.length) {
        const k = c.versionIds.length;
        if (k > 0 && lastId(c) === ref[k - 1]) continue; // same log, possibly behind
      } else if (c.versionIds[ref.length - 1] === lastId(reference)) {
        // Extends the reference: verify, and on success it becomes the reference.
        if (passes(await verify(c))) reference = c;
        else c.status = "invalid";
        continue;
      }
      // Diverges.
      if (!passes(await verify(c))) {
        c.status = "invalid";
        continue;
      }
      let k = 0;
      while (k < Math.min(c.versionIds.length, ref.length) && c.versionIds[k] === ref[k]) k++;
      fork = {
        version: k + 1,
        copies: [reference, c].map((x) => ({ source: x.copy.source, versionId: x.versionIds[k] ?? "" })),
      };
      break;
    }
  }

  if (reference && !fork && options.retainedVersionId !== undefined) {
    const retained = options.retainedVersionId;
    const number = Number(/^(\d+)-/.exec(retained)?.[1] ?? NaN);
    const at = reference.versionIds[number - 1];
    if (!Number.isInteger(number) || number < 1) {
      fail("invalid-evidence", "SELECTOR_INVALID", "retainedVersionId is not a versionId");
    } else if (at === undefined) {
      warnings.push({ code: "retained-version-not-found", message: `the log has fewer than ${number} entries; it may have been truncated or rolled back` });
    } else if (at !== retained) {
      fork = { version: number, copies: [{ source: reference.copy.source, versionId: at }, { source: "retained", versionId: retained }] };
    }
  }

  const copies: CopyReport[] = candidates.map((c) => {
    const versionId = lastId(c);
    if (c.status === "unavailable") return { source: c.copy.source, status: "unavailable" };
    if (c.status === "invalid") return { source: c.copy.source, versionId, status: "invalid" };
    if (reference && c.versionIds.length === reference.versionIds.length && versionId === lastId(reference)) {
      return { source: c.copy.source, versionId, status: "current" };
    }
    if (reference && c.versionIds.length < reference.versionIds.length && versionId === reference.versionIds[c.versionIds.length - 1]) {
      return { source: c.copy.source, versionId, status: "behind" };
    }
    return { source: c.copy.source, versionId, status: "invalid" };
  });
  for (const [i, report] of copies.entries()) {
    const c = candidates[i];
    if (report.status === "behind") warnings.push({ code: "copy-behind", source: report.source, message: `copy is ${reference!.versionIds.length - c.versionIds.length} entries behind the reference copy` });
    if (report.status === "invalid") warnings.push({ code: "copy-invalid", source: report.source, message: `copy failed verification at entry ${(c.verification?.failure?.index ?? 0) + 1}` });
    if (report.status === "unavailable") warnings.push({ code: "copy-unavailable", source: report.source, message: c.copy.unavailable ?? "copy could not be retrieved" });
  }
  const usable = copies.filter((c) => c.status === "current" || c.status === "behind").length;
  return {
    reference: fork ? null : (reference?.verification ?? null),
    referenceSource: fork ? undefined : reference?.copy.source,
    copies,
    warnings,
    fork,
    insufficientCopies: options.minCopies !== undefined && usable < options.minCopies,
  };
}

/** VH-Log "Selecting a Version". With no selector, the last valid entry. */
export function selectVersion(
  result: LogVerification,
  selector: { versionId?: string; versionTime?: string; versionNumber?: number },
): VerifiedEntry | undefined {
  const given = [selector.versionId, selector.versionTime, selector.versionNumber].filter((v) => v !== undefined);
  if (given.length > 1) fail("invalid-evidence", "SELECTOR_INVALID", "at most one of versionId, versionTime and versionNumber may be given");
  if (selector.versionId !== undefined) return result.entries.find((v) => v.entry.versionId === selector.versionId);
  if (selector.versionNumber !== undefined) return result.entries.find((v) => v.versionNumber === selector.versionNumber);
  if (selector.versionTime !== undefined) {
    const at = parseVersionTime(selector.versionTime, 3);
    let found: VerifiedEntry | undefined;
    for (const v of result.entries) if (v.time <= at) found = v;
    return found;
  }
  return result.entries[result.entries.length - 1];
}

// ---------------------------------------------------------------------------
// Building entries

/** Produces the proof array for an entry (without its `proof` member). */
export type EntrySigner = (unsigned: JsonObject) => Promise<DataIntegrityProof[]>;

/** One proof by `signer`, with proofPurpose assertionMethod unless overridden. */
export function signWith(
  signer: ProofSigner,
  options: { cryptosuite: CryptosuiteName; verificationMethod: string; proofPurpose?: string; created?: string },
): EntrySigner {
  return async (unsigned) => [
    await createProof(unsigned, {
      type: "DataIntegrityProof",
      cryptosuite: options.cryptosuite,
      verificationMethod: options.verificationMethod,
      proofPurpose: options.proofPurpose ?? "assertionMethod",
      ...(options.created ? { created: options.created } : {}),
    }, signer),
  ];
}

export interface EntryInput {
  versionTime: string;
  parameters: JsonObject;
  state: JsonObject;
  sign: EntrySigner;
}

/** An entry with its versionId computed and no proof yet. */
export type UnsignedEntry = Omit<LogEntry, "proof">;

/**
 * VH-Log Create, without signing: `parameters` and `state` carry the `{SCID}`
 * placeholder wherever the SCID will appear (including `parameters.scid`).
 */
export function prepareGenesis(input: Omit<EntryInput, "sign">): UnsignedEntry {
  const preliminary: JsonObject = { versionId: SCID_PLACEHOLDER, versionTime: input.versionTime, parameters: input.parameters, state: input.state };
  const scid = computeScid(preliminary);
  const resolved = replaceText(preliminary, SCID_PLACEHOLDER, scid) as JsonObject;
  const entryHash = vhHash({ ...resolved, versionId: scid });
  return { ...(resolved as unknown as UnsignedEntry), versionId: `1-${entryHash}` };
}

/** VH-Log Update, without signing: the next entry after `previous`. */
export function prepareNext(previous: { versionId: string }, input: Omit<EntryInput, "sign">): UnsignedEntry {
  const number = Number(VERSION_ID.exec(previous.versionId)?.[1] ?? NaN);
  if (!Number.isInteger(number)) fail("invalid-evidence", "VERSION_ID_FORMAT", "previous versionId is malformed");
  const preliminary: JsonObject = { versionId: previous.versionId, versionTime: input.versionTime, parameters: input.parameters, state: input.state };
  return { ...(preliminary as unknown as UnsignedEntry), versionId: `${number + 1}-${vhHash(preliminary)}` };
}

/** Sign a prepared entry. */
export async function signEntry(unsigned: UnsignedEntry, sign: EntrySigner): Promise<LogEntry> {
  return { ...unsigned, proof: await sign(unsigned) };
}

/** VH-Log Create: prepare and sign the first entry. */
export async function createLog(input: EntryInput): Promise<LogEntry> {
  return signEntry(prepareGenesis(input), input.sign);
}

/** VH-Log Update: prepare and sign the next entry after `previous`. Parameters default to `{}`. */
export async function appendEntry(previous: LogEntry, input: EntryInput): Promise<LogEntry> {
  return signEntry(prepareNext(previous, input), input.sign);
}

/** A witness proof approving `versionId`, signed with a did:key witness key. */
export async function createWitnessProof(
  signer: ProofSigner,
  versionId: string,
  cryptosuite: CryptosuiteName = "eddsa-jcs-2022",
  created?: string,
): Promise<DataIntegrityProof> {
  const vm = `did:key:${signer.publicKeyMultibase}#${signer.publicKeyMultibase}`;
  const [proof] = await signWith(signer, { cryptosuite, verificationMethod: vm, created })({ versionId });
  return proof;
}

/** JSON Lines serialization: compact JSON per entry, newline-terminated. */
export function serializeLog(entries: LogEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/** The plain VH-Log 1.0 specialisation: `logVersion`, SHA-256 and eddsa-jcs-2022, unknown parameters ignored. */
export const vhLog10: Specialisation = {
  name: "vh-log",
  versionParameter: "logVersion",
  versions: { "vh-log:1.0": { vhLog: "vh-log:1.0", rank: 1, entrySuites: ["eddsa-jcs-2022"], witnessSuites: ["eddsa-jcs-2022"] } },
  keys: { kind: "updateKeys" },
  unknownParameters: "ignore",
};

/** Parse a log file (strict JSON Lines). Structural checks happen in `verifyLog`. */
/**
 * The UTF-8 byte length of the stored line each entry `parseLog` returned was
 * parsed from, without its line feed: the size the entry size limit measures
 * (P14.13), carried with the parsed entry so a log assembled from parsed
 * entries (an Original's anchoring inscriptions, a copy) is measured as
 * stored.
 */
const storedLineBytes = new WeakMap<object, number>();

/** Parse a log file's text, one entry per line, keeping each entry's stored line size (P14.13). */
export function parseLog(text: string, limits?: ParseLimits): JsonValue[] {
  const entries = parseJsonLines(text, limits);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  entries.forEach((entry, i) => {
    if (typeof entry === "object" && entry !== null) storedLineBytes.set(entry, utf8Length(lines[i]));
  });
  return entries;
}

export type { ErrorCategory };
