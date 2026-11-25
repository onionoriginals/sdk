/**
 * A new did:webvh 1.0 author DID for did:og (P5.8): one genesis entry whose
 * DID document has one assertionMethod key, `#key-1`, which is not one of
 * the log's updateKeys (P5.3). By default it lives on originals.build under
 * `authors:<name>`, so the DID is `did:webvh:<SCID>:originals.build:authors:<name>`
 * and its log is served at `https://originals.build/authors/<name>/did.jsonl`.
 */
import { createLog, serializeLog, signWith, verifyLog, type LogEntry } from "@originals/vh/log";
import { didWebvh, didWebvhLogUrl } from "@originals/vh/webvh";
import { parseJsonLines } from "@originals/vh/json";
import type { AuthorKeys } from "./keys.js";

export const DEFAULT_AUTHOR_DOMAIN = "originals.build";

/** A path segment of a did:webvh: letters, digits, `.`, `_` and `-`. */
export function checkPathSegment(segment: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(segment) || segment === "." || segment === "..") throw new Error(`${JSON.stringify(segment)} is not a did:webvh path segment`);
  return segment;
}

/** The DID's location part: `domain[:segment...]`, with a port percent-encoded as did:webvh requires. */
export function webvhLocation(domain: string, path: string[]): string {
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(domain)) throw new Error(`${domain} is not a domain`);
  return [domain.replace(":", "%3A"), ...path.map(checkPathSegment)].join(":");
}

export interface AuthorDid {
  did: string;
  /** The `did.jsonl` to serve, exactly. */
  log: string;
  /** The HTTPS URL a did:webvh resolver fetches it from. */
  url: string;
  entries: LogEntry[];
  verificationMethod: string;
  versionId: string;
}

export async function createAuthorDid(keys: AuthorKeys, options: { domain?: string; path: string[]; now?: Date }): Promise<AuthorDid> {
  const location = webvhLocation(options.domain ?? DEFAULT_AUTHOR_DOMAIN, options.path);
  const template = `did:webvh:{SCID}:${location}`;
  const update = keys.update.publicKeyMultibase;
  const time = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const genesis = await createLog({
    versionTime: time,
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [update] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: template,
      verificationMethod: [{ id: `${template}#key-1`, type: "Multikey", controller: template, publicKeyMultibase: keys.assertion.publicKeyMultibase }],
      assertionMethod: [`${template}#key-1`],
    },
    sign: signWith(keys.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${update}#${update}` }),
  });
  const did = genesis.state.id as string;
  return { did, log: serializeLog([genesis]), url: didWebvhLogUrl(did), entries: [genesis], verificationMethod: `${did}#key-1`, versionId: genesis.versionId };
}

export interface AuthorLogCheck {
  ok: boolean;
  reason?: string;
  latestVersionId?: string;
  /** Every verified version, in order: its versionId, DID document and whether it deactivates the DID. */
  versions: Array<{ versionId: string; document: Record<string, unknown>; deactivated: boolean }>;
}

/** Whether `text` is this DID's log, verifying under did:webvh and naming the DID (P5.14). */
export async function checkAuthorLog(did: string, text: string): Promise<AuthorLogCheck> {
  let entries: unknown[];
  try {
    entries = parseJsonLines(text);
  } catch (error) {
    return { ok: false, reason: `not JSON Lines: ${(error as Error).message}`, versions: [] };
  }
  const v = await verifyLog(entries, { specialisation: didWebvh, now: Date.now() + 300_000 });
  if (v.failure) return { ok: false, reason: v.failure.error.message, versions: [] };
  const last = v.entries[v.entries.length - 1];
  if (!v.entries.some((e) => e.entry.state.id === did)) return { ok: false, reason: "the log is not this DID's", versions: [] };
  const versions = v.entries.map((e) => ({ versionId: e.entry.versionId, document: e.entry.state, deactivated: e.active.deactivated }));
  return { ok: true, latestVersionId: last.entry.versionId, versions };
}
