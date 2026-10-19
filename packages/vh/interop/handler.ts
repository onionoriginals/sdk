/**
 * The vh interop protocol (brianorwhatever/vh, docs/interop-protocol.md) for
 * @originals/vh, under profile vh-log-interop-0. This maps the protocol's
 * requests and error codes onto the library; it adds no protocol logic.
 */
import { hex } from "@scure/base";
import {
  base58btcEncode,
  createProof,
  didKeyMultikey,
  localSigner,
  sha256Multihash,
  verifyProof,
  type DataIntegrityProof,
} from "../src/crypto/index.js";
import { OriginalsError } from "../src/errors.js";
import { INTEROP_PARSE, canonicalize, isJsonObject, parseJson, type JsonObject, type JsonValue } from "../src/json/index.js";
import {
  appendEntry,
  computeScid,
  createLog,
  createWitnessProof,
  keyHash,
  resolveCopies,
  serializeLog,
  vhHash,
  vhLog10,
  type EntrySigner,
  type LogEntry,
  type LogVerification,
  type VerifiedEntry,
} from "../src/log/index.js";

type Input = Record<string, unknown>;

/** Library error codes to vh-log-interop-0 error codes (profile section 6). */
const CODES: Array<[RegExp, string]> = [
  [/^(JSON_|JSONL_|LOG_EMPTY$|LOG_LINE_INVALID$)/, "invalid-log"],
  [/^ENTRY_MEMBERS$/, "invalid-entry"],
  [/^ENTRY_AFTER_DEACTIVATION$/, "entry-after-deactivation"],
  [/^VERSION_(MISSING|UNSUPPORTED|DOWNGRADE)$/, "unsupported-log-version"],
  [/^PARAMETER_/, "invalid-parameter"],
  [/^PREROTATION_/, "prerotation-violation"],
  [/^UNAUTHORIZED_KEY$/, "unauthorized-key"],
  [/^(PROOF_|CRYPTOSUITE_)/, "invalid-proof"],
  [/^MULTIHASH_UNSUPPORTED$/, "invalid-hash-algorithm"],
  [/^(VERSION_ID_FORMAT|VERSION_NUMBER|MULTIHASH_INVALID|MULTIBASE_)/, "invalid-version-id"],
  [/^ENTRY_HASH_MISMATCH$/, "entry-hash-mismatch"],
  [/^VERSION_TIME_FUTURE$/, "future-version-time"],
  [/^VERSION_TIME_/, "invalid-version-time"],
  [/^SCID_MISMATCH$/, "scid-mismatch"],
  [/^WITNESS_THRESHOLD$/, "witness-threshold-not-met"],
  [/^WITNESS_FILE_INVALID$/, "invalid-witness-file"],
];

export function interopCode(error: OriginalsError): string {
  for (const [pattern, code] of CODES) if (pattern.test(error.code)) return code;
  return `unmapped:${error.code}`;
}

const signerFor = (seed: unknown) => localSigner("Ed25519", hex.decode(String(seed)));
const didKeyVm = (multikey: string) => `did:key:${multikey}#${multikey}`;

/** One proof per seed, in order, with `created` set to the entry's versionTime (profile section 2). */
function signers(seeds: unknown, created: string): EntrySigner {
  return async (unsigned) => {
    const proofs: DataIntegrityProof[] = [];
    for (const seed of seeds as string[]) {
      const signer = signerFor(seed);
      proofs.push(await createProof(unsigned, {
        type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", verificationMethod: didKeyVm(signer.publicKeyMultibase),
        created, proofPurpose: "assertionMethod",
      }, signer));
    }
    return proofs;
  };
}

function lastLine(log: string): LogEntry {
  const lines = log.trimEnd().split("\n");
  return parseJson(lines[lines.length - 1], INTEROP_PARSE) as unknown as LogEntry;
}

/** The versionTime of the first invalid entry k, when its line still has a parseable one. */
function firstInvalidTime(log: string, k: number): number | undefined {
  try {
    const line = parseJson(log.split("\n")[k - 1] ?? "", INTEROP_PARSE);
    const t = isJsonObject(line) && typeof line.versionTime === "string" ? Date.parse(line.versionTime) : NaN;
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

const RESOLVE_OPTIONS = new Set(["versionId", "versionTime", "versionNumber", "minCopies"]);

function metadataOf(log: LogVerification, selected: VerifiedEntry): JsonObject {
  const first = log.entries[0];
  const last = log.entries[log.entries.length - 1];
  const witness = last.active.witness;
  return {
    versionId: selected.entry.versionId,
    versionTime: selected.entry.versionTime,
    versionNumber: selected.versionNumber,
    created: first.entry.versionTime,
    updated: last.entry.versionTime,
    scid: log.scid!,
    deactivated: log.deactivated,
    ttl: last.active.ttl,
    witness: Object.keys(witness).length === 0 ? null : witness,
    watchers: last.active.watchers,
    updateKeys: selected.active.updateKeys,
    nextKeyHashes: selected.active.nextKeyHashes,
  };
}

const failure = (code: string, version: number | null, message: string) => ({ valid: false, error: { code, version, message } });

async function resolve(input: Input): Promise<JsonValue> {
  const options = (input.options ?? {}) as Input;
  for (const key of Object.keys(options)) {
    if (!RESOLVE_OPTIONS.has(key)) return failure("invalid-option", null, `unknown option ${key}`);
  }
  const selectors = ["versionId", "versionTime", "versionNumber"].filter((k) => options[k] !== undefined);
  if (selectors.length > 1) return failure("invalid-option", null, "more than one version selector");

  const now = Date.parse(String(input.now));
  const primary = { source: "primary", log: String(input.log), ...("witness" in input ? { witnessFile: input.witness } : {}) };
  const copies = ((input.copies ?? []) as Input[]).map((c) => ({
    source: String(c.source),
    ...(typeof c.log === "string" ? { log: c.log } : { unavailable: String(c.unavailable ?? "unavailable") }),
    ...("witness" in c ? { witnessFile: c.witness } : {}),
  }));
  const result = await resolveCopies(primary, copies, {
    specialisation: vhLog10, now, parse: INTEROP_PARSE,
    retainedVersionId: input.retainedVersionId as string | undefined,
    minCopies: options.minCopies as number | undefined,
  });

  if (result.fork) {
    return { valid: false, error: { code: "fork-detected", version: result.fork.version, message: "two verified copies diverge", fork: result.fork as unknown as JsonValue } };
  }
  const log = result.reference;
  if (!log || log.entries.length === 0) {
    const primaryFailure = log?.failure;
    if (primaryFailure) {
      const empty = primaryFailure.error.code === "LOG_EMPTY";
      return failure(interopCode(primaryFailure.error), empty ? null : primaryFailure.index + 1, primaryFailure.error.message);
    }
    return failure("invalid-log", 1, "no copy of the log could be verified");
  }
  if (result.insufficientCopies) return failure("min-copies-not-met", null, `fewer than ${String(options.minCopies)} copies match`);

  const k = log.failure ? log.failure.index + 1 : null;
  const error = log.failure ? { code: interopCode(log.failure.error), version: k, message: log.failure.error.message } : null;
  let selected: VerifiedEntry | undefined;
  if (selectors.length === 0) {
    selected = log.entries[log.entries.length - 1];
  } else {
    const id = options.versionId as string | undefined;
    const number = options.versionNumber as number | undefined;
    const time = options.versionTime as string | undefined;
    if (number !== undefined) selected = log.entries.find((v) => v.versionNumber === number);
    else if (id !== undefined) selected = log.entries.find((v) => v.entry.versionId === id);
    else {
      const at = Date.parse(time!);
      for (const v of log.entries) if (v.time <= at) selected = v;
    }
    // A target at or after the first invalid entry fails with that entry's error.
    const invalidTime = k !== null ? firstInvalidTime(String(input.log), k) : undefined;
    const atOrAfter = k !== null && (
      (number !== undefined && number >= k) ||
      (id !== undefined && /^\d+-/.test(id) && Number(id.split("-")[0]) >= k) ||
      (time !== undefined && invalidTime !== undefined && Date.parse(time) >= invalidTime));
    if (atOrAfter && error) return { valid: false, error };
    if (!selected) return failure("not-found", null, "the target version is not in the log");
  }
  const warnings: JsonObject[] = result.warnings.map((w) => ({ ...w }) as unknown as JsonObject);
  if (log.failure) warnings.push({ code: "invalid-entries", message: `entries from ${k} failed verification` });
  const metadata: JsonObject = { ...metadataOf(log, selected), warnings };
  if (copies.length > 0) metadata.copies = result.copies as unknown as JsonValue;
  return { valid: true, state: selected.entry.state, metadata, firstInvalidVersion: k, error };
}

const OPS: Record<string, (input: Input) => Promise<JsonValue> | JsonValue> = {
  jcs: (i) => ({ output: canonicalize(parseJson(String(i.text), INTEROP_PARSE)) }),
  hash: (i) => ({ output: base58btcEncode(sha256Multihash(new TextEncoder().encode(String(i.data)))) }),
  multikey: (i) => ({ multikey: signerFor(i.seed).publicKeyMultibase }),
  "key-hash": (i) => ({ output: keyHash(String(i.multikey)) }),
  scid: (i) => ({ scid: computeScid(i.entry as JsonObject) }),
  "entry-hash": (i) => {
    const { proof: _proof, ...entry } = i.entry as JsonObject;
    return { hash: vhHash({ ...entry, versionId: String(i.previousVersionId) }) };
  },
  sign: async (i) => {
    const signer = signerFor(i.seed);
    const proof = await createProof(i.document as JsonObject, {
      type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022",
      verificationMethod: (i.verificationMethod as string | undefined) ?? didKeyVm(signer.publicKeyMultibase),
      proofPurpose: "assertionMethod", ...(i.created ? { created: String(i.created) } : {}),
    }, signer);
    return { proof: proof as unknown as JsonValue };
  },
  verify: (i) => {
    try {
      const proof = i.proof as DataIntegrityProof;
      if (!isJsonObject(proof) || proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") return { valid: false };
      return { valid: verifyProof(i.document as JsonObject, proof, didKeyMultikey(proof.verificationMethod)) };
    } catch (error) {
      if (error instanceof OriginalsError) return { valid: false };
      throw error;
    }
  },
  create: async (i) => {
    const parameters = { ...(i.parameters as JsonObject) };
    parameters.scid ??= "{SCID}";
    parameters.logVersion ??= "vh-log:1.0";
    const versionTime = String(i.versionTime);
    const entry = await createLog({ versionTime, parameters, state: i.state as JsonObject, sign: signers(i.signers, versionTime) });
    return { log: serializeLog([entry]), scid: entry.parameters.scid as string, versionId: entry.versionId };
  },
  update: async (i) => {
    const log = String(i.log);
    const versionTime = String(i.versionTime);
    const entry = await appendEntry(lastLine(log), {
      versionTime, parameters: (i.parameters as JsonObject | undefined) ?? {}, state: i.state as JsonObject, sign: signers(i.signers, versionTime),
    });
    return { log: (log.endsWith("\n") ? log : `${log}\n`) + serializeLog([entry]), versionId: entry.versionId };
  },
  witness: async (i) => {
    const signer = signerFor(i.seed);
    const proof = await createWitnessProof(signer, String(i.versionId), "eddsa-jcs-2022", i.created as string | undefined);
    return { proof: proof as unknown as JsonValue };
  },
  resolve,
};

export async function handle(op: string, input: Input): Promise<{ ok: true; result: JsonValue } | { ok: false; error: string }> {
  const fn = OPS[op];
  if (!fn) return { ok: false, error: `unknown op ${op}` };
  try {
    return { ok: true, result: await fn(input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
