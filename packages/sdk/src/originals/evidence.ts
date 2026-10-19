/**
 * Evidence packages (spec section 7; PROVISIONAL format, D4; owner decision
 * Q3: an uncompressed ZIP). The layout:
 *
 *   originals-evidence.json               the manifest
 *   asset/did.jsonl                       the asset log, through the checkpoint
 *   asset/did-witness.json                witness proofs, when there are any
 *   authors/<sha256(did) hex>/did.jsonl   each author DID's log
 *   authors/<sha256(did) hex>/did-witness.json
 *   resources/<digest>                    resource bytes, named by digest
 *
 * Nothing outside this layout is accepted (P7.5).
 */
import { OriginalsError } from "@originals/vh";
import { sha256 } from "@originals/vh/crypto";
import { isJsonObject, parseJson, type JsonValue } from "@originals/vh/json";
import { ORIGINALS_METHOD, checkDigest, type AuthorDidEvidence } from "@originals/vh/originals";
import { hex } from "@scure/base";
import { readZip, writeZip, type ZipLimits } from "./zip.js";

export const EVIDENCE_FORMAT = "originals-evidence/0.1";
export const MANIFEST = "originals-evidence.json";

export type MissingItem =
  | { kind: "resource"; resource: string; version: number; digest: string; versionId: string }
  | { kind: "identity"; did: string };

export interface EvidenceManifest {
  format: typeof EVIDENCE_FORMAT;
  profile: typeof ORIGINALS_METHOD;
  original: string;
  /** The checkpoint this package is evidence for: the last entry of `asset/did.jsonl`. */
  checkpoint: string;
  /** The packager's head when it packaged, which may be later than the checkpoint (P7.6). */
  head: string;
  completeness: "complete" | "partial";
  missing: MissingItem[];
}

export interface EvidenceContents {
  manifest: EvidenceManifest;
  log: string;
  witness?: unknown;
  authors: AuthorDidEvidence[];
  bytes: Record<string, Uint8Array>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function evidenceError(code: string, message: string): never {
  throw new OriginalsError("invalid-evidence", code, message);
}

export function authorPath(did: string): string {
  return `authors/${hex.encode(sha256(encoder.encode(did)))}`;
}

export function writeEvidence(contents: EvidenceContents): Uint8Array {
  const files = new Map<string, Uint8Array>();
  files.set(MANIFEST, encoder.encode(`${JSON.stringify(contents.manifest, null, 2)}\n`));
  files.set("asset/did.jsonl", encoder.encode(contents.log));
  if (contents.witness !== undefined) files.set("asset/did-witness.json", encoder.encode(JSON.stringify(contents.witness)));
  for (const author of contents.authors) {
    const base = authorPath(author.did);
    files.set(`${base}/did.jsonl`, encoder.encode(typeof author.log === "string" ? author.log : author.log.map((e) => `${JSON.stringify(e)}\n`).join("")));
    if (author.witness !== undefined) files.set(`${base}/did-witness.json`, encoder.encode(JSON.stringify(author.witness)));
  }
  for (const [digest, bytes] of Object.entries(contents.bytes)) files.set(`resources/${digest}`, bytes);
  return writeZip(files);
}

const LAYOUT = /^(?:originals-evidence\.json|asset\/did\.jsonl|asset\/did-witness\.json|authors\/[0-9a-f]{64}\/(?:did\.jsonl|did-witness\.json)|resources\/z[1-9A-HJ-NP-Za-km-z]{1,120})$/;

function text(bytes: Uint8Array, name: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return evidenceError("EVIDENCE_ENCODING", `${name} is not UTF-8`);
  }
}

function checkManifest(value: JsonValue): EvidenceManifest {
  if (!isJsonObject(value)) evidenceError("EVIDENCE_MANIFEST", "the manifest must be an object");
  const keys = ["format", "profile", "original", "checkpoint", "head", "completeness", "missing"];
  if (Object.keys(value).length !== keys.length || !keys.every((k) => k in value)) evidenceError("EVIDENCE_MANIFEST", `the manifest has exactly ${keys.join(", ")}`);
  if (value.format !== EVIDENCE_FORMAT) throw new OriginalsError("unsupported-profile", "EVIDENCE_FORMAT", `unsupported evidence format ${JSON.stringify(value.format)}`);
  if (value.profile !== ORIGINALS_METHOD) throw new OriginalsError("unsupported-profile", "EVIDENCE_PROFILE", `unsupported profile ${JSON.stringify(value.profile)}`);
  for (const k of ["original", "checkpoint", "head"]) if (typeof value[k] !== "string") evidenceError("EVIDENCE_MANIFEST", `${k} must be a string`);
  if (value.completeness !== "complete" && value.completeness !== "partial") evidenceError("EVIDENCE_MANIFEST", "completeness must be complete or partial");
  if (!Array.isArray(value.missing)) evidenceError("EVIDENCE_MANIFEST", "missing must be an array");
  return value as unknown as EvidenceManifest;
}

/** Read and check an evidence package's archive, layout and manifest. Verification is separate. */
export function readEvidence(zip: Uint8Array, limits?: ZipLimits): EvidenceContents {
  const files = readZip(zip, limits);
  for (const name of files.keys()) if (!LAYOUT.test(name)) evidenceError("EVIDENCE_LAYOUT", `${name} is not part of the evidence package layout`);
  const manifestBytes = files.get(MANIFEST);
  const logBytes = files.get("asset/did.jsonl");
  if (!manifestBytes || !logBytes) evidenceError("EVIDENCE_LAYOUT", "the manifest and asset/did.jsonl are required");
  const manifest = checkManifest(parseJson(text(manifestBytes, MANIFEST)));

  const authors = new Map<string, AuthorDidEvidence>();
  const authorDids = new Set<string>();
  for (const line of text(logBytes, "asset/did.jsonl").trimEnd().split("\n")) {
    try {
      const entry = JSON.parse(line) as { state?: { author?: { did?: unknown } } };
      if (typeof entry.state?.author?.did === "string") authorDids.add(entry.state.author.did);
    } catch {
      // A malformed line fails verification later.
    }
  }
  for (const did of authorDids) {
    const base = authorPath(did);
    const log = files.get(`${base}/did.jsonl`);
    if (!log) continue;
    const witness = files.get(`${base}/did-witness.json`);
    authors.set(did, { did, log: text(log, `${base}/did.jsonl`), ...(witness ? { witness: parseJson(text(witness, `${base}/did-witness.json`)) } : {}) });
  }
  for (const name of files.keys()) {
    if (name.startsWith("authors/") && ![...authorDids].some((did) => name.startsWith(`${authorPath(did)}/`))) {
      evidenceError("EVIDENCE_LAYOUT", `${name} belongs to no author the log names`);
    }
  }
  const bytes: Record<string, Uint8Array> = {};
  for (const [name, data] of files) {
    if (!name.startsWith("resources/")) continue;
    const digest = name.slice("resources/".length);
    checkDigest(digest, name);
    bytes[digest] = data;
  }
  const witness = files.get("asset/did-witness.json");
  return {
    manifest,
    log: text(logBytes, "asset/did.jsonl"),
    ...(witness ? { witness: parseJson(text(witness, "asset/did-witness.json")) } : {}),
    authors: [...authors.values()],
    bytes,
  };
}
