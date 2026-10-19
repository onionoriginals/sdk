/**
 * did:vh resolution (swcurran/didvh@e0b7cba with PR 3, extensions, treated as merged).
 *
 * The log is passed directly (`didLog`, `didWitness`). Retrieval from `src`
 * returns `featureNotSupported`, as did:vh permits, until the SSRF-safe fetcher
 * lands (plan 011, PR 7); so do `checkWatchers`, `extraWatchers` and
 * `minCopies` until comparing copies lands (PR 6).
 */
import { OriginalsError } from "../errors.js";
import { isJsonObject, type JsonObject } from "../json/index.js";
import {
  parseLog,
  selectVersion,
  verifyLog,
  type LogLimits,
  type LogVerification,
  type Specialisation,
  type VerifiedEntry,
  type VersionRules,
} from "../log/index.js";

const DID_VH = /^did:vh:[1-9A-HJ-NP-Za-km-z]{46}$/;

/** The `did:vh:1.0` method value: VH-Log 1.0, SHA-256 and eddsa-jcs-2022 only. */
export const DID_VH_1_0: VersionRules = Object.freeze({
  vhLog: "vh-log:1.0",
  rank: 1,
  entrySuites: ["eddsa-jcs-2022"],
  witnessSuites: ["eddsa-jcs-2022"],
}) as VersionRules;

/** Plain did:vh: the state is the DID document, and its id is did:vh:<SCID>. */
export const didVh: Specialisation = {
  name: "did:vh",
  versionParameter: "method",
  versions: { "did:vh:1.0": DID_VH_1_0 },
  keys: { kind: "updateKeys" },
  validateEntry: ({ entry, scid }) => {
    if (entry.state.id !== `did:vh:${scid}`) {
      throw new OriginalsError("invalid-evidence", "DIDVH_STATE_ID", "state.id must be did:vh:<SCID>");
    }
  },
};

/**
 * A did:vh extension (did:vh PR 3): its own `method` values and specialisation
 * rules, and a deterministic DID document derivation when its state is not a
 * DID document.
 */
export interface DidVhExtension extends Omit<Specialisation, "versions" | "versionParameter"> {
  methods: Readonly<Record<string, VersionRules>>;
  /** The DID document for the last of `entries` (the verified prefix up to that version). */
  deriveDocument?: (entries: VerifiedEntry[]) => JsonObject;
}

export interface DidVhResolutionOptions {
  didLog?: string | unknown[];
  didWitness?: unknown;
  src?: string;
  versionId?: string;
  versionTime?: string;
  versionNumber?: number;
  checkWatchers?: number | "all";
  extraWatchers?: string[];
  minCopies?: number;
  /** Extensions this resolver implements. */
  extensions?: DidVhExtension[];
  now?: number | Date;
  limits?: LogLimits;
}

export type DidVhError = "invalidDid" | "invalidOptions" | "notFound" | "featureNotSupported";

export interface DidVhResolution {
  didResolutionMetadata: {
    contentType?: "application/did+json";
    error?: DidVhError;
    problemDetails?: { type: string; title: string; detail: string; code?: string };
    warnings?: Array<{ code: string; message: string }>;
  };
  didDocument: JsonObject | null;
  didDocumentMetadata: {
    versionId?: string;
    versionTime?: string;
    created?: string;
    updated?: string;
    scid?: string;
    deactivated?: boolean;
    ttl?: string;
    witness?: { threshold: string; witnesses: Array<{ id: string }> };
    watchers?: string[];
  };
  /** The verified log, for callers that apply further rules (never a substitute for them). */
  log?: LogVerification;
}

function failure(error: DidVhError, detail: string, code?: string): DidVhResolution {
  return {
    didResolutionMetadata: { error, problemDetails: { type: `https://w3id.org/security#${error}`, title: error, detail, ...(code ? { code } : {}) } },
    didDocument: null,
    didDocumentMetadata: {},
  };
}

function specialisationFor(firstMethod: unknown, extensions: DidVhExtension[]): { spec: Specialisation; extension?: DidVhExtension } {
  for (const extension of extensions) {
    if (typeof firstMethod === "string" && Object.prototype.hasOwnProperty.call(extension.methods, firstMethod)) {
      const { methods, deriveDocument: _derive, ...rules } = extension;
      return { spec: { ...rules, versionParameter: "method", versions: methods }, extension };
    }
  }
  return { spec: didVh };
}

export async function resolveDidVh(did: string, options: DidVhResolutionOptions): Promise<DidVhResolution> {
  if (typeof did !== "string" || !DID_VH.test(did)) return failure("invalidDid", "the DID does not match the did:vh ABNF");

  const extensions = options.extensions ?? [];
  for (const extension of extensions) {
    if (Object.keys(extension.methods).some((m) => m.startsWith("did:vh:"))) {
      return failure("invalidOptions", `extension ${extension.name} claims a did:vh method value`);
    }
  }
  if ((options.didLog === undefined) === (options.src === undefined)) return failure("invalidOptions", "exactly one of didLog and src must be given");
  if (options.didWitness !== undefined && options.didLog === undefined) return failure("invalidOptions", "didWitness may be given only with didLog");
  const selectors = [options.versionId, options.versionTime, options.versionNumber].filter((v) => v !== undefined);
  if (selectors.length > 1) return failure("invalidOptions", "at most one of versionId, versionTime and versionNumber may be given");
  if (options.versionNumber !== undefined && !(Number.isInteger(options.versionNumber) && options.versionNumber > 0)) {
    return failure("invalidOptions", "versionNumber must be a positive integer");
  }
  if (options.src !== undefined) {
    try {
      new URL(options.src);
    } catch {
      return failure("invalidOptions", "src must be an absolute URL");
    }
    return failure("featureNotSupported", "this resolver does not retrieve from src references");
  }
  if (options.checkWatchers !== undefined || options.extraWatchers !== undefined || options.minCopies !== undefined) {
    return failure("featureNotSupported", "checkWatchers, extraWatchers and minCopies are not supported yet");
  }

  let entries: unknown[];
  try {
    entries = typeof options.didLog === "string" ? parseLog(options.didLog) : options.didLog!;
  } catch (error) {
    if (error instanceof OriginalsError) return failure("invalidDid", error.message, error.code);
    throw error;
  }
  const firstParameters = isJsonObject(entries[0]) && isJsonObject(entries[0].parameters) ? entries[0].parameters : {};
  const { spec, extension } = specialisationFor(firstParameters.method, extensions);
  const log = await verifyLog(entries, { specialisation: spec, witnessFile: options.didWitness, now: options.now, limits: options.limits });

  if (log.entries.length === 0) {
    const error = log.failure?.error;
    return failure("invalidDid", error?.message ?? "the DID log is empty", error?.code);
  }
  if (log.scid !== did.slice("did:vh:".length)) return failure("invalidDid", "the log's SCID is not the DID's");

  let selected: VerifiedEntry | undefined;
  try {
    selected = selectVersion(log, options);
  } catch (error) {
    if (error instanceof OriginalsError) return failure("invalidOptions", error.message, error.code);
    throw error;
  }
  if (!selected) {
    // A requested version that exists in the file but failed verification is invalid, not missing.
    const inFile = entries.slice(log.entries.length).some((raw) =>
      isJsonObject(raw) && typeof raw.versionId === "string" &&
      (raw.versionId === options.versionId || (options.versionNumber !== undefined && raw.versionId.startsWith(`${options.versionNumber}-`))));
    if (inFile) return failure("invalidDid", log.failure?.error.message ?? "the requested version is invalid", log.failure?.error.code);
    return failure("notFound", "the requested version does not exist");
  }

  const first = log.entries[0];
  const last = log.entries[log.entries.length - 1];
  const prefix = log.entries.slice(0, selected.versionNumber);
  const deactivated = log.deactivated;
  const witness = last.active.witness;
  const document = extension?.deriveDocument ? extension.deriveDocument(prefix) : selected.entry.state;
  const warnings = log.failure ? [{ code: "invalid-entries", message: `entries from ${log.failure.index + 1} failed verification: ${log.failure.error.message}` }] : undefined;

  return {
    didResolutionMetadata: { contentType: "application/did+json", ...(warnings ? { warnings } : {}) },
    didDocument: deactivated && selectors.length === 0 ? null : document,
    didDocumentMetadata: {
      versionId: selected.entry.versionId,
      versionTime: selected.entry.versionTime,
      created: first.entry.versionTime,
      updated: last.entry.versionTime,
      scid: log.scid,
      deactivated,
      ttl: String(last.active.ttl),
      ...(Object.keys(witness).length > 0
        ? { witness: { threshold: String(Number(witness.threshold)), witnesses: witness.witnesses as Array<{ id: string }> } }
        : {}),
      watchers: last.active.watchers,
    },
    log,
  };
}
