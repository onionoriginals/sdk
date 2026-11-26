/**
 * Giving an existing did:og Original a did:webvh alias from logs signed
 * outside the SDK (P3.6, P14.29): read its bundle, prepare the exact entry the
 * existing author key signs, and check the signed entry with the alias's own
 * log before anything is hosted (`checkAliasUpdate`, @originals/vh/og).
 *
 * Browser-safe and key-free: nothing here takes, makes or imports a key,
 * starts a new genesis, signs, writes or reads the network. A `verified`
 * result is a local check only: the alias is not hosted, and no one else can
 * resolve it, until a host serves its log and the package (P14.11).
 */
import {
  aliasCheckpoint, checkAliasUpdate, readManifest, readPackageZip, parseLogFile, prepareAliasEntry, stateOf,
  type AliasUpdateOptions, type AliasUpdateReport, type Descriptor, type EvidenceSet, type OgEntry, type Report, type UnsignedEntry,
} from "@originals/vh/og";

/**
 * The evidence set of a did:og bundle (an evidence package, P14.10). Throws
 * when the bytes are not a did:og package, naming why, so a did:og bundle is
 * never handed to another verifier.
 */
export function bundleEvidence(bytes: Uint8Array, source = "bundle"): EvidenceSet {
  const files = readPackageZip(bytes);
  const manifest = files["originals-evidence.json"];
  const log = files["asset/did.jsonl"];
  if (!manifest || !log) throw new Error("This is not a did:og bundle: it has no originals-evidence.json and asset/did.jsonl (P14.10)");
  const ids = parseLogFile(log).values.map((e) => (e as OgEntry).versionId);
  const m = readManifest(manifest, ids);
  if (m.unsupported) throw new Error(`This bundle's profile is ${m.profile}, not a did:og profile this SDK verifies (P14.1)`);
  return { original: m.original, checkpoint: null, inputs: [{ kind: "package", source: `package:${source}`, bytes }] };
}

/** What an alias entry extends, and how its author signs it. */
export interface AliasSigningRequest {
  original: string;
  /** The checkpoint the entry extends, exactly. */
  checkpoint: string;
  /** The author DID and the verification method whose key signs (`signEntry(unsigned, verificationMethod, signer)`). */
  author: string;
  verificationMethod: string;
  /** The entry to sign, byte for byte as the check expects it. */
  unsigned: UnsignedEntry;
}

/**
 * The exact unsigned entry that adds `alias` to the Original and changes
 * nothing else. Refused when the evidence does not verify, or the Original is
 * anchored (after anchoring no entry adds a did:webvh alias, P9.10).
 */
export async function aliasSigningRequest(evidence: EvidenceSet, alias: string, now: () => Date = () => new Date()): Promise<AliasSigningRequest> {
  const cp = await aliasCheckpoint(evidence);
  if (!cp.entry) throw new Error(cp.problem ?? "The bundle has no checkpoint an alias entry can extend");
  const prior = stateOf(cp.entry);
  const versionTime = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    original: evidence.original, checkpoint: cp.entry.versionId,
    author: prior.author.did, verificationMethod: prior.author.verificationMethod,
    unsigned: prepareAliasEntry(cp.entry, alias, versionTime),
  };
}

/** The bundle's verification and its checkpoint facts, and why an alias cannot extend it, if it cannot. */
export async function inspectBundle(evidence: EvidenceSet): Promise<{ report: Report; checkpoint: string | null; author: string | null; aliases: string[]; resource: Descriptor | null; problem: string | null }> {
  const cp = await aliasCheckpoint(evidence);
  const state = cp.entry ? stateOf(cp.entry) : null;
  return {
    report: cp.report, checkpoint: cp.report.checkpoint, author: state?.author.did ?? null,
    aliases: state?.asset.aliases ?? [], resource: state?.asset.resource ?? null, problem: cp.problem,
  };
}

/** Check a signed alias entry and the alias's signed did:webvh log against a bundle. Nothing is hosted. */
export function checkBundleAlias(input: { evidence: EvidenceSet; entry: string | Uint8Array; aliasLog: string | Uint8Array }, options?: AliasUpdateOptions): Promise<AliasUpdateReport> {
  return checkAliasUpdate(input, options);
}

export const describeAliasCheck = (r: AliasUpdateReport): string => [
  r.status === "verified" ? "Verified as a local check. Not hosted: no one else can resolve this alias until it is published." : "Not verified.",
  `Original:  ${r.original}`,
  `Author:    ${r.author ?? "—"}`,
  `Alias:     ${r.alias ?? "—"}${r.aliasHost ? ` (${r.aliasHost})` : ""}`,
  `Checkpoint ${r.checkpointBefore ?? "—"} → ${r.checkpointAfter ?? "—"}`,
  ...r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.id}${!c.ok && c.detail ? `: ${c.detail}` : ""}`),
].join("\n");

