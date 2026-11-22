/**
 * Hosting a did:og (P6.7, P7.20, P3.6, P9.7, P14.11): a shared host's atomic
 * save, the did:webvh alias check in both directions, and the files and
 * headers a host serves under the alias.
 */
import { OriginalsError } from "../errors.js";
import { isJsonObject, parseJsonLines, type JsonValue } from "../json/index.js";
import { verifyLog } from "../log/index.js";
import { didWebvh, didWebvhLogUrl, parseDidWebvh } from "../webvh/index.js";
import { checkChainLink, parseLogFile, resourceDigest, type OgEntry } from "./log.js";
import { buildPackage, type MissingItem } from "./package.js";
import type { EvidenceSet, Report } from "./report.js";
import { OgRuleError } from "./rules.js";
import { stateOf } from "./state.js";
import { verifyOriginal } from "./verify.js";

// ---------------------------------------------------------------------------
// Shared-host saves (P6.7)

/** A submission (section 14, "Shared-host saves"): `entry` is the exact line. PROVISIONAL transport. */
export interface Submission {
  original: string;
  entry: string;
  /** New resource bytes the entry introduces. */
  resources: Array<{ digest: string; bytes: Uint8Array }>;
  /** Signer DID logs the host may need to check the entry. */
  identities: Array<{ did: string; log: string }>;
}

export type SaveResponse =
  | { result: "accepted"; checkpoint: string; head: string }
  | { result: "already-accepted"; checkpoint: string; head: string }
  | { result: "stale-parent"; head: string }
  /** PROVISIONAL: the spec names no response for a submission that does not verify. */
  | { result: "rejected"; rule: string; reason: string };

/** What a host keeps for each Original. Writes must be durable before they resolve (P6.2). */
export interface HostStore {
  /** The accepted log, exactly as stored (signed lines, never re-serialised). */
  readLog(original: string): Promise<string | undefined>;
  /** Append one line durably, after the head was compared (the caller holds the Original's lock). */
  appendLine(original: string, line: string): Promise<void>;
  /** Create the log with its genesis line. */
  createLog(original: string, line: string): Promise<void>;
  putResource(original: string, digest: string, bytes: Uint8Array): Promise<void>;
  getResource(original: string, digest: string): Promise<Uint8Array | undefined>;
  putIdentity(did: string, log: string): Promise<void>;
  getIdentity(did: string): Promise<string | undefined>;
}

/** An in-memory store, for tests and for a host that keeps its own durability. */
export function memoryHostStore(): HostStore & { logs: Map<string, string> } {
  const logs = new Map<string, string>();
  const resources = new Map<string, Uint8Array>();
  const identities = new Map<string, string>();
  return {
    logs,
    readLog: (o) => Promise.resolve(logs.get(o)),
    appendLine: (o, l) => (logs.set(o, (logs.get(o) ?? "") + l), Promise.resolve()),
    createLog: (o, l) => (logs.set(o, l), Promise.resolve()),
    putResource: (o, d, b) => (resources.set(`${o} ${d}`, b), Promise.resolve()),
    getResource: (o, d) => Promise.resolve(resources.get(`${o} ${d}`)),
    putIdentity: (d, l) => (identities.set(d, l), Promise.resolve()),
    getIdentity: (d) => Promise.resolve(identities.get(d)),
  };
}

const enc = new TextEncoder();

/**
 * A shared host (P6.7). Per Original, one step at a time: a byte-identical
 * resubmission returns its checkpoint and the head; otherwise the entry is
 * accepted only if its parent is the head and it verifies against that head
 * (history, signer binding and grants; freshness is not required), and it is
 * stored durably before the head moves. A host never re-signs, rebases or
 * changes a submission, and never publishes a refused one.
 */
export class SharedHost {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly store: HostStore) {}

  submit(s: Submission): Promise<SaveResponse> {
    const prior = this.locks.get(s.original) ?? Promise.resolve();
    const run = prior.then(() => this.step(s), () => this.step(s));
    this.locks.set(s.original, run.catch(() => undefined));
    return run;
  }

  private async step(s: Submission): Promise<SaveResponse> {
    if (!s.entry.endsWith("\n") || s.entry.indexOf("\n") !== s.entry.length - 1) return { result: "rejected", rule: "P14.2", reason: "a submission is exactly one log line" };
    const parsed = parseLogFile(s.entry);
    if (parsed.failure) return { result: "rejected", rule: ruleOf(parsed.failure.error), reason: parsed.failure.error.message };
    const entry = parsed.values[0] as OgEntry;
    const log = (await this.store.readLog(s.original)) ?? "";
    const lines = log ? log.slice(0, -1).split("\n") : [];
    const entries = lines.map((l) => JSON.parse(l) as OgEntry);
    const headId = entries.length ? entries[entries.length - 1].versionId : null;

    // Byte-identical retry (P6.7, P6.4): its checkpoint and the current head, no append.
    const known = lines.indexOf(s.entry.slice(0, -1));
    if (known >= 0) return { result: "already-accepted", checkpoint: entries[known].versionId, head: headId! };

    // The parent is the predecessor named by the entry's hash (P14.29), so recompute against the head.
    const isGenesis = typeof entry.versionId === "string" && entry.versionId.startsWith("1-");
    if (isGenesis && entries.length) return { result: "stale-parent", head: headId! };
    if (!isGenesis && !entries.length) return { result: "rejected", rule: "P6.7", reason: "the host holds no log for this Original" };

    for (const i of s.identities) await this.store.putIdentity(i.did, i.log);
    const candidate = [...entries, entry];
    // A parent that is not the head: the entry does not chain onto the head, whatever else it is.
    if (!isGenesis && !chainsOnto(entries, entry)) return { result: "stale-parent", head: headId! };

    const report = await this.check(s, candidate, log + s.entry);
    const label = report.entries?.find((e) => e.versionId === entry.versionId);
    if (!label || label.status !== "accepted") {
      return { result: "rejected", rule: label && "rule" in label ? label.rule : "P5.6", reason: label ? `the entry is ${label.status}` : "the entry does not verify against the head" };
    }
    // P7.20: an entry extending one that is neither current-key nor endorsed is accepted only if it is a current-key author entry.
    const parentLabel = !isGenesis ? report.entries?.find((e) => e.versionId === headId) : undefined;
    if (parentLabel && parentLabel.status === "accepted" && parentLabel.authority !== "current-key") {
      // Its own endorsement by this entry does not count yet: judge it before the entry.
      const without = await this.check(s, entries, log);
      const before = without.entries?.find((e) => e.versionId === headId);
      const unendorsed = before && before.status === "accepted" && before.authority !== "current-key" && !before.endorsed;
      if (unendorsed && ("editor" in entry.state || label.authority !== "current-key")) {
        return { result: "rejected", rule: "P7.20", reason: "only a current-key author entry may extend an entry that is neither current-key nor endorsed" };
      }
    }
    // Durable before acknowledging (P6.7, P6.2): resource bytes first, then the line.
    for (const r of s.resources) {
      if (resourceDigest(r.bytes) !== r.digest) return { result: "rejected", rule: "P4.3", reason: `resource bytes do not match ${r.digest}` };
    }
    for (const r of s.resources) await this.store.putResource(s.original, r.digest, r.bytes);
    if (isGenesis) await this.store.createLog(s.original, s.entry);
    else await this.store.appendLine(s.original, s.entry);
    return { result: "accepted", checkpoint: entry.versionId, head: entry.versionId };
  }

  /** Verify `text`, the stored lines byte for byte and any candidate line, against the identities the host holds. */
  private async check(s: Submission, entries: OgEntry[], text: string): Promise<Report> {
    const dids = new Set<string>();
    for (const e of entries) for (const k of ["author", "editor"] as const) {
      const r = e.state[k];
      if (isJsonObject(r) && typeof r.did === "string") dids.add(r.did);
    }
    const inputs: EvidenceSet["inputs"] = [{ kind: "log", source: "host", bytes: enc.encode(text) }];
    for (const did of dids) {
      const log = await this.store.getIdentity(did);
      if (log) inputs.push({ kind: "signer-history", source: `host:${did}`, bytes: enc.encode(log), did });
    }
    return verifyOriginal({ original: s.original, inputs });
  }
}

function chainsOnto(entries: OgEntry[], entry: OgEntry): boolean {
  try {
    checkChainLink(entry, entries.length, entries[entries.length - 1], entries[0].parameters.scid as string);
    return true;
  } catch (error) {
    if (error instanceof OgRuleError && (error.rule === "P14.29" || error.rule === "P14.27")) return false;
    return true; // another failure: let the verifier report it
  }
}

const ruleOf = (e: OriginalsError) => (e.details as { rule?: string } | undefined)?.rule ?? "P14.2";

// ---------------------------------------------------------------------------
// The did:webvh alias (P3.6, P14.11)

export interface AliasCheck {
  alias: string;
  /** The alias log verifies under did:webvh and its latest DID document lists the did:og (P3.6). */
  pointsToOriginal: boolean;
  /** The Original's state at the checkpoint lists the alias (P3.6). */
  listedByOriginal: boolean;
  /** Both directions: only then is it the Original's alias. */
  confirmed: boolean;
  reason?: string;
}

/** P3.6: a did:webvh is an alias only if its document points to the did:og and the asset state lists it. */
export async function checkAlias(aliasLog: string, original: string, checkpointEntry: OgEntry | undefined): Promise<AliasCheck> {
  let entries: JsonValue[];
  try {
    entries = parseJsonLines(aliasLog);
  } catch (error) {
    return { alias: "", pointsToOriginal: false, listedByOriginal: false, confirmed: false, reason: (error as Error).message };
  }
  const verified = await verifyLog(entries, { specialisation: didWebvh, now: 8_640_000_000_000_000 });
  const last = verified.entries[verified.entries.length - 1];
  const alias = typeof last?.entry.state.id === "string" ? last.entry.state.id : "";
  const aka = last?.entry.state.alsoKnownAs;
  const pointsToOriginal = !verified.failure && Array.isArray(aka) && aka.includes(original);
  const listedByOriginal = !!checkpointEntry && stateOf(checkpointEntry).asset.aliases.includes(alias);
  return {
    alias, pointsToOriginal, listedByOriginal, confirmed: pointsToOriginal && listedByOriginal,
    reason: verified.failure ? verified.failure.error.message : !pointsToOriginal ? "the alias's DID document does not list the did:og" : !listedByOriginal ? "the Original's state does not list the alias" : undefined,
  };
}

// ---------------------------------------------------------------------------
// The hosted layout (P14.11) and response headers (P9.7)

/** Media types whose content is active and is served isolated (P9.7). PROVISIONAL list. */
const ACTIVE = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml", "text/javascript", "application/javascript"]);
export const isActiveContent = (mediaType: string) => ACTIVE.has(mediaType.toLowerCase());

/** The headers a resource is served with: its signed media type, never sniffed; active content sandboxed (P9.7). */
export function resourceHeaders(mediaType: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": mediaType, "X-Content-Type-Options": "nosniff" };
  if (isActiveContent(mediaType)) h["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return h;
}

export interface HostedLayout {
  alias: string;
  aliasLog: string;
  packageRoot: string;
  resources: Array<{ url: string; headers: Record<string, string> }>;
}

/** Where a host serves an Original under its alias (P14.11): the alias's did.jsonl, and the package unpacked under `originals/`. */
export function hostedLayout(alias: string, versions: Array<{ digest: string; mediaType: string }>): HostedLayout {
  parseDidWebvh(alias);
  const aliasLog = didWebvhLogUrl(alias);
  const base = aliasLog.slice(0, -"did.jsonl".length);
  return {
    alias,
    aliasLog,
    packageRoot: `${base}originals/`,
    resources: versions.map((v) => ({ url: `${base}originals/resources/${v.digest}`, headers: resourceHeaders(v.mediaType) })),
  };
}

/**
 * The files a host serves under an alias (P14.11): the alias's `did.jsonl`
 * and, under `originals/`, the evidence package unpacked.
 */
export function hostedFiles(input: {
  aliasLog: Uint8Array;
  original: string;
  assetLog: Uint8Array;
  signers: Array<{ did: string; log: Uint8Array }>;
  resources: Record<string, Uint8Array>;
  missing?: MissingItem[];
}): Record<string, Uint8Array> {
  const parsed = parseLogFile(input.assetLog);
  const pkg = buildPackage({
    original: input.original, assetLog: input.assetLog, versionIds: (parsed.values as OgEntry[]).map((e) => e.versionId),
    signers: input.signers, resources: input.resources, missing: input.missing ?? [],
  });
  const files: Record<string, Uint8Array> = { "did.jsonl": input.aliasLog };
  for (const [name, bytes] of Object.entries(pkg.files)) files[`originals/${name}`] = bytes;
  return files;
}
