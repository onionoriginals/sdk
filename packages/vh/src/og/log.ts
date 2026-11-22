/**
 * The did:og log format (P14.1–P14.3, P14.27–P14.29): the `did.jsonl` line
 * format, strict JSON with the P14.3 number bound, the entry shape, SCID and
 * entry hash, the parameters an entry may carry, and the writer that prepares
 * and signs an entry. The format keeps the entry shape and hash algorithms of
 * VH Log 9bffcc18 and the DIF did:vh byte for byte, but depends on neither
 * (D10): authority comes from the signer DIDs, never from `updateKeys`.
 */
import { base58btcDecode, base58btcEncode, createProof, decodeSha256Multihash, sha256Multihash, type DataIntegrityProof, type ProofSigner } from "../crypto/index.js";
import { OriginalsError } from "../errors.js";
import { canonicalBytes, canonicalize, isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json/index.js";
import { parseVersionTime, compactLineError } from "../log/index.js";
import { OG_LIMITS, OG_METHOD, reject } from "./rules.js";

export const SCID_PLACEHOLDER = "{SCID}";

/** An asset log entry (P14.27). */
export interface OgEntry extends JsonObject {
  versionId: string;
  versionTime: string;
  parameters: JsonObject;
  state: JsonObject;
  proof: JsonValue[];
}

// ---------------------------------------------------------------------------
// Hashes (P14.7, P14.28, P14.29)

/** `base58btc(multihash(JCS(value)))` with SHA-256 and no multibase prefix: an SCID or entry hash. */
export function ogHash(value: JsonValue): string {
  return base58btcEncode(sha256Multihash(canonicalBytes(value)));
}

/** A resource digest: `z` and the base58btc SHA-256 multihash of the bytes (P14.7). */
export function resourceDigest(bytes: Uint8Array): string {
  return "z" + base58btcEncode(sha256Multihash(bytes));
}

function isSha256Multihash(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) return false;
  try {
    const bytes = base58btcDecode(text);
    decodeSha256Multihash(bytes);
    return base58btcEncode(bytes) === text;
  } catch {
    return false;
  }
}

/** P14.7: a digest in exactly the encoding `resourceDigest` produces. */
export function isDigest(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("z") && isSha256Multihash(value.slice(1));
}

/** P14.28, P14.29: an SCID or entry hash naming SHA-256, in canonical base58btc. */
export function isOgHash(value: unknown): value is string {
  return typeof value === "string" && isSha256Multihash(value);
}

// ---------------------------------------------------------------------------
// Strict JSON (P14.3)

const MAX = 9_007_199_254_740_991n;

/**
 * Whether a JSON number literal's exact decimal value, as written, has
 * magnitude above 2^53 − 1 (P14.3): `1e16` and `9007199254740993.0` do.
 */
export function exceedsNumberBound(literal: string): boolean {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return false;
  const fraction = m[2] ?? "";
  const digits = BigInt((m[1] + fraction).replace(/^0+(?=\d)/, ""));
  if (digits === 0n) return false;
  const exponent = Number(m[3] ?? "0") - fraction.length;
  // Exponents this large or small decide the answer without arithmetic on huge powers.
  if (exponent > 400) return true;
  if (exponent < -400) return false;
  return exponent >= 0 ? digits * 10n ** BigInt(exponent) > MAX : digits > MAX * 10n ** BigInt(-exponent);
}

/** The number literals of a JSON text, outside strings. */
function numberLiterals(text: string): string[] {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const found = m.exec(text);
      if (found) {
        out.push(found[0]);
        i += found[0].length - 1;
      }
    }
  }
  return out;
}

/**
 * Parse one JSON value under P14.3: duplicate keys, lone surrogates, negative
 * zero, nesting deeper than 64 and any number whose exact value exceeds
 * 2^53 − 1 are rejected.
 */
export function parseStrict(text: string): JsonValue {
  for (const literal of numberLiterals(text)) {
    if (exceedsNumberBound(literal)) reject("P14.3", "JSON_UNSAFE_NUMBER", `number ${literal} exceeds 2^53 - 1`);
  }
  try {
    return parseJson(text, { maxDepth: OG_LIMITS.depth });
  } catch (error) {
    if (error instanceof OriginalsError) reject("P14.3", error.code, error.message);
    throw error;
  }
}

/** Check that a parsed value obeys P14.3 (for values not parsed from text, such as decoded CBOR). */
export function checkStrictValue(value: JsonValue, depth = 1): void {
  if (typeof value === "object" && value !== null && depth > OG_LIMITS.depth) reject("P14.3", "JSON_TOO_DEEP", "nested deeper than 64 levels");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || Math.abs(value) > Number(MAX)) reject("P14.3", "JSON_UNSAFE_NUMBER", `number ${value} is not allowed`);
  } else if (typeof value === "string") {
    canonicalize(value);
  } else if (Array.isArray(value)) {
    for (const item of value) checkStrictValue(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      canonicalize(k);
      checkStrictValue(v, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// did.jsonl (P14.2)

export interface ParsedLog {
  /** The entries parsed before the first line that fails, as JSON values. */
  values: JsonValue[];
  /** The exact text of each parsed line, without its line feed. */
  lines: string[];
  /** The first line that breaks P14.2 or P14.3, if any. */
  failure?: { index: number; error: OriginalsError };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Read an asset log file (P14.2). Every line is one compact JSON value ending
 * in a single LF; a CR, whitespace outside strings or a missing final LF ends
 * the readable prefix. A file that is not UTF-8, or has no entry, has none.
 */
export function parseLogFile(file: Uint8Array | string): ParsedLog {
  let text: string;
  try {
    text = typeof file === "string" ? file : decoder.decode(file);
  } catch {
    return { values: [], lines: [], failure: { index: 0, error: new OriginalsError("invalid-evidence", "LOG_NOT_UTF8", "the log is not UTF-8 (P14.2)", { rule: "P14.2" }) } };
  }
  if (text.length === 0) return { values: [], lines: [], failure: { index: 0, error: new OriginalsError("invalid-evidence", "LOG_EMPTY", "the log has no entries (P14.2)", { rule: "P14.2" }) } };
  const lines = text.split("\n");
  const finalLf = lines[lines.length - 1] === "";
  if (finalLf) lines.pop();
  const out: ParsedLog = { values: [], lines: [] };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    try {
      if (line.length === 0) reject("P14.2", "LOG_LINE_FORMAT", `line ${index + 1} is empty`);
      const bad = compactLineError(line) ?? (index === lines.length - 1 && !finalLf ? "the last line does not end in LF" : undefined);
      if (bad) reject("P14.2", "LOG_LINE_FORMAT", `line ${index + 1}: ${bad}`);
      out.values.push(parseStrict(line));
      out.lines.push(line);
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      out.failure = { index, error };
      break;
    }
  }
  return out;
}

/** One `did.jsonl` line: the entry's JCS form and a line feed. Key order is free (P14.2); JCS makes the bytes reproducible. */
export function entryLine(entry: JsonObject): string {
  return canonicalize(entry) + "\n";
}

export function serializeLog(entries: readonly JsonObject[]): string {
  return entries.map(entryLine).join("");
}

// ---------------------------------------------------------------------------
// Entry shape (P14.27), size (P14.13) and proof shape (P14.8)

const ENTRY_MEMBERS = ["parameters", "proof", "state", "versionId", "versionTime"];
const PROOF_MEMBERS = ["cryptosuite", "proofPurpose", "proofValue", "type", "verificationMethod"];
const VERSION_ID = /^([1-9]\d*)-(.+)$/;

/** The version number of a versionId, or NaN when it has none. */
export function versionNumber(versionId: string): number {
  const m = VERSION_ID.exec(versionId);
  return m ? Number(m[1]) : Number.NaN;
}

function sameMembers(object: JsonObject, members: readonly string[]): boolean {
  const keys = Object.keys(object).sort();
  return keys.length === members.length && keys.every((k, i) => k === members[i]);
}

/** UTF-8 length of the entry's JCS form (P14.13). */
export function entryBytes(entry: JsonValue): number {
  return canonicalBytes(entry).length;
}

/** P14.27 and P14.13: an entry is an object of exactly the five members, of their types, within 65,536 bytes. */
export function checkEntryShape(raw: JsonValue): OgEntry {
  if (!isJsonObject(raw) || !sameMembers(raw, ENTRY_MEMBERS)) {
    reject("P14.27", "ENTRY_MEMBERS", "an entry has exactly versionId, versionTime, parameters, state and proof");
  }
  if (typeof raw.versionId !== "string" || typeof raw.versionTime !== "string" || !isJsonObject(raw.parameters) || !isJsonObject(raw.state) || !Array.isArray(raw.proof)) {
    reject("P14.27", "ENTRY_MEMBERS", "an entry member has the wrong type");
  }
  if (raw.proof.length !== 1) reject("P5.2", "ENTRY_PROOFS", "an entry carries exactly one proof (P14.8)");
  checkProofShape(raw.proof[0]);
  if (entryBytes(raw) > OG_LIMITS.entryBytes) reject("P14.13", "ENTRY_TOO_LARGE", `entry exceeds ${OG_LIMITS.entryBytes} bytes as its JCS form`, "limit-exceeded");
  return raw as OgEntry;
}

/** P14.8: exactly the five proof members, DataIntegrityProof, eddsa-jcs-2022, assertionMethod, a 64-byte base58btc signature. */
export function checkProofShape(proof: JsonValue): DataIntegrityProof {
  if (!isJsonObject(proof) || !sameMembers(proof, PROOF_MEMBERS)) reject("P14.8", "PROOF_MEMBERS", "a proof has exactly type, cryptosuite, verificationMethod, proofPurpose and proofValue");
  if (proof.type !== "DataIntegrityProof" || proof.proofPurpose !== "assertionMethod" || typeof proof.verificationMethod !== "string") {
    reject("P14.8", "PROOF_INVALID", "a proof is a DataIntegrityProof for assertionMethod");
  }
  if (proof.cryptosuite !== "eddsa-jcs-2022") reject("P5.12", "CRYPTOSUITE_UNSUPPORTED", "only eddsa-jcs-2022 is allowed (P14.8)");
  const value = proof.proofValue;
  let signature: Uint8Array | undefined;
  if (typeof value === "string" && value.startsWith("z")) {
    try {
      signature = base58btcDecode(value.slice(1));
      if (base58btcEncode(signature) !== value.slice(1)) signature = undefined;
    } catch {
      signature = undefined;
    }
  }
  if (!signature || signature.length !== 64) reject("P14.8", "PROOF_VALUE", "proofValue is z and the base58btc of a 64-byte signature");
  return proof as unknown as DataIntegrityProof;
}

// ---------------------------------------------------------------------------
// SCID and entry hash (P14.28, P14.29)

function withoutProof(entry: JsonObject): JsonObject {
  const { proof: _proof, ...rest } = entry;
  return rest;
}

function replaceInStrings(value: JsonValue, from: string, to: string): JsonValue {
  // The SCID is base58, so it never needs escaping in JSON text.
  return JSON.parse(JSON.stringify(value).split(from).join(to)) as JsonValue;
}

/** P14.28: the genesis entry with `proof` removed, versionId `{SCID}` and every occurrence of its `scid` replaced by `{SCID}`. */
export function scidInput(genesis: JsonObject): JsonObject {
  const scid = (genesis.parameters as JsonObject | undefined)?.scid;
  if (typeof scid !== "string" || scid.length === 0) reject("P14.28", "SCID_MISSING", "the genesis entry names no scid");
  return replaceInStrings({ ...withoutProof(genesis), versionId: SCID_PLACEHOLDER }, scid, SCID_PLACEHOLDER) as JsonObject;
}

/** P14.29: the entry without `proof`, with versionId replaced by the predecessor's versionId or, for the genesis entry, the SCID. */
export function entryHashInput(entry: JsonObject, predecessor: string): JsonObject {
  return { ...withoutProof(entry), versionId: predecessor };
}

/**
 * Check how `entry`, at line `index`, chains to `previous` (P14.27–P14.29,
 * P14.2): its version number, its entry hash over the predecessor's
 * versionId, and its versionTime at least one millisecond later. For the
 * genesis entry the SCID is verified too. Returns the SCID.
 */
export function checkChainLink(entry: OgEntry, index: number, previous: OgEntry | undefined, scid?: string): string {
  const m = VERSION_ID.exec(entry.versionId);
  if (!m || String(Number(m[1])) !== m[1] || Number(m[1]) !== index + 1) reject("P14.27", "VERSION_NUMBER", `entry ${index + 1} does not carry version number ${index + 1}`);
  if (!isOgHash(m[2])) reject("P14.29", "ENTRY_HASH_ALGORITHM", "an entry hash is a canonical base58btc SHA-256 multihash");
  let theScid = scid;
  if (index === 0) {
    const named = entry.parameters.scid;
    if (!isOgHash(named)) reject("P14.28", "SCID_ALGORITHM", "the SCID is a canonical base58btc SHA-256 multihash");
    if (ogHash(scidInput(entry)) !== named) reject("P14.28", "SCID_MISMATCH", "the SCID is not the hash of the genesis entry with placeholders");
    theScid = named;
  }
  if (!theScid) reject("P14.28", "SCID_MISSING", "no SCID to chain from");
  const predecessor = previous ? previous.versionId : theScid;
  if (ogHash(entryHashInput(entry, predecessor)) !== m[2]) reject("P14.29", "ENTRY_HASH_MISMATCH", `entry ${index + 1}'s hash does not cover its predecessor`);
  const time = versionTimeOf(entry);
  if (previous && time - versionTimeOf(previous) < 1) reject("P14.2", "VERSION_TIME_ORDER", "versionTime is not at least 1 ms after the previous entry's");
  return theScid;
}

/** P14.2: at most three fractional digits, ending in Z. */
export function versionTimeOf(entry: { versionTime: unknown }): number {
  if (typeof entry.versionTime !== "string" || !entry.versionTime.endsWith("Z")) reject("P14.2", "VERSION_TIME_FORMAT", "versionTime ends in Z");
  try {
    return parseVersionTime(entry.versionTime, 3);
  } catch {
    return reject("P14.2", "VERSION_TIME_FORMAT", `versionTime ${entry.versionTime} has more than three fractional digits or is not a time`);
  }
}

/** Whether `entry` (a later entry) carries the parameters of a deactivation (P14.1, P6.5). */
export function isDeactivation(entry: OgEntry): boolean {
  return entry.parameters.deactivated === true;
}

/**
 * P14.1: the parameters an entry may carry. Genesis: exactly method, scid and
 * `updateKeys: []`. A later author entry: `{}` or `{"updateKeys": []}`; a
 * deactivation: `{"deactivated": true}` with or without `updateKeys: []`. An
 * editor entry: `{}`. Any other member or value, including a null, is rejected.
 */
export function checkParameters(entry: OgEntry, index: number, editor: boolean): void {
  const p = entry.parameters;
  const keys = Object.keys(p).sort();
  for (const [k, v] of Object.entries(p)) if (v === null) reject("P14.1", "PARAMETER_NULL", `parameter ${k} is null`);
  if ("updateKeys" in p && !(Array.isArray(p.updateKeys) && p.updateKeys.length === 0)) {
    reject("P14.1", "UPDATE_KEYS", "updateKeys must be [] in this method version (P5.9)");
  }
  if ("nextKeyHashes" in p) reject("P5.9", "NEXT_KEY_HASHES", "nextKeyHashes is not allowed (P14.1)");
  if ("witness" in p && !(isJsonObject(p.witness) && Object.keys(p.witness).length === 0)) reject("P9.9", "ASSET_WITNESS", "an asset log activates no witnesses");
  if (index === 0) {
    if (keys.join() !== "method,scid,updateKeys") reject("P14.1", "GENESIS_PARAMETERS", "genesis parameters are exactly method, scid and updateKeys");
    if (p.method !== OG_METHOD) reject("P14.1", "METHOD_UNSUPPORTED", `method ${JSON.stringify(p.method)} is not ${OG_METHOD}`, "unsupported-profile");
    return;
  }
  if ("method" in p) reject("P14.1", "METHOD_LATER", "a later entry does not set method");
  if (editor) {
    if (keys.length !== 0) reject("P14.1", "EDITOR_PARAMETERS", "an editor entry's parameters are {} (P5.16)");
    return;
  }
  const allowed = p.deactivated === true ? ["deactivated", "deactivated,updateKeys"] : ["", "updateKeys"];
  if (!allowed.includes(keys.join())) reject("P14.1", "LATER_PARAMETERS", "a later entry's parameters are {}, {\"updateKeys\": []} or a deactivation's");
}

export interface LogStructure {
  /** The entries, from genesis, that pass the format checks; the valid prefix. */
  entries: OgEntry[];
  scid?: string;
  /** The first entry that fails, with the rule it fails. */
  failure?: { index: number; error: OriginalsError };
  /** True when the log is longer than P14.13 allows; `entries` is then the first 10,000 at most. */
  limitExceeded: boolean;
}

/**
 * Check a sequence of entries, in log order, against the log format alone
 * (P14.1–P14.3, P14.27–P14.29): shape, version numbers, SCID, entry hashes,
 * versionTime and parameters. State, signer binding and authority are checked
 * by the verifier. The result is the valid prefix and the first failure.
 */
export function checkLogStructure(values: readonly JsonValue[]): LogStructure {
  const out: LogStructure = { entries: [], limitExceeded: false };
  for (let index = 0; index < values.length; index++) {
    if (index >= OG_LIMITS.entries) {
      out.limitExceeded = true;
      out.failure = { index, error: new OriginalsError("limit-exceeded", "LOG_TOO_LONG", `an asset log holds at most ${OG_LIMITS.entries} entries (P14.13)`, { rule: "P14.13" }) };
      break;
    }
    try {
      checkStrictValue(values[index]);
      const entry = checkEntryShape(values[index]);
      out.scid = checkChainLink(entry, index, out.entries[index - 1], out.scid);
      checkParameters(entry, index, isJsonObject(entry.state) && "editor" in entry.state);
      out.entries.push(entry);
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      out.failure = { index, error };
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writer

export type UnsignedEntry = Omit<OgEntry, "proof">;

/**
 * Prepare a genesis entry (P14.28): `state` names the identifier as
 * `did:og:{SCID}`; the SCID is computed over the entry with placeholders and
 * substituted, and versionId becomes `1-` and the entry hash.
 */
export function prepareGenesis(input: { versionTime: string; state: JsonObject }): UnsignedEntry {
  const preliminary: JsonObject = {
    versionId: SCID_PLACEHOLDER,
    versionTime: input.versionTime,
    parameters: { method: OG_METHOD, scid: SCID_PLACEHOLDER, updateKeys: [] },
    state: input.state,
  };
  const scid = ogHash(preliminary);
  const entry = replaceInStrings(preliminary, SCID_PLACEHOLDER, scid) as JsonObject;
  entry.versionId = `1-${ogHash({ ...entry, versionId: scid })}`;
  return entry;
}

/** Prepare the entry after `previous` (P14.29). */
export function prepareNext(previous: { versionId: string }, input: { versionTime: string; parameters: JsonObject; state: JsonObject }): UnsignedEntry {
  const n = versionNumber(previous.versionId) + 1;
  const body: JsonObject = { versionId: previous.versionId, versionTime: input.versionTime, parameters: input.parameters, state: input.state };
  return { ...body, versionId: `${n}-${ogHash(body)}` };
}

/** Sign a prepared entry with its signer's verification method (P5.2, P14.8): one eddsa-jcs-2022 proof. */
export async function signEntry(unsigned: UnsignedEntry, verificationMethod: string, signer: ProofSigner): Promise<OgEntry> {
  if (signer.keyType !== "Ed25519") reject("P5.12", "SIGNER_KEY_TYPE", "entries are signed with Ed25519 keys only");
  const proof = await createProof(unsigned, {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    verificationMethod,
    proofPurpose: "assertionMethod",
  }, signer);
  const entry = { ...unsigned, proof: [proof as unknown as JsonObject] } as OgEntry;
  if (entryBytes(entry) > OG_LIMITS.entryBytes) reject("P14.13", "ENTRY_TOO_LARGE", "the SDK refuses to sign an entry over the entry limit", "limit-exceeded");
  return entry;
}
