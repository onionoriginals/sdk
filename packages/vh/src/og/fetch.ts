/**
 * Fetching evidence for a did:og verification (P8.5, P14.13). The verifier
 * itself never fetches: a report is a function of its evidence set (P7.17).
 * A caller that fetches builds a larger evidence set with this, and a
 * refused fetch adds nothing to it. On top of `safeFetch` (HTTPS only, every
 * address public, the connection made to the vetted address, no redirects,
 * size and time bounded), did:og also refuses a locator whose host is an IP
 * literal, and checks the locator after percent-decoding it.
 */
import { OriginalsError } from "../errors.js";
import { safeFetch, type SafeFetchOptions } from "../fetch/index.js";
import type { EvidenceInput } from "./report.js";
import { OG_LIMITS } from "./rules.js";

export type FetchableKind = "log" | "signer-history" | "resource" | "package";

/** P14.13: a fetched log file is at most 16 MiB, a resource 64 MiB, a package 512 MiB (P7.5); every fetch at most 15 s. */
export const FETCH_CAPS: Readonly<Record<FetchableKind, number>> = Object.freeze({
  log: OG_LIMITS.logFileBytes,
  "signer-history": OG_LIMITS.logFileBytes,
  resource: OG_LIMITS.resourceBytes,
  package: 512 * 1024 * 1024,
});

export type FetchedEvidence =
  | { status: "fetched"; input: EvidenceInput; obtained: string; mediaType?: string }
  /** Nothing from the locator enters the evidence set; `code` and `reason` say why (P8.5). */
  | { status: "refused"; locator: string; code: string; reason: string };

function ipLiteral(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || /^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h);
}

/** Fetch one input for an evidence set, or say why nothing from the locator enters it (P8.5). */
export async function fetchEvidence(locator: string, kind: FetchableKind, options: SafeFetchOptions & { now?: () => Date; did?: string } = {}): Promise<FetchedEvidence> {
  const refused = (code: string, reason: string): FetchedEvidence => ({ status: "refused", locator, code, reason });
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return refused("FETCH_URL", `${locator} is not a URL`);
  }
  // P8.5: the host may not be an IP literal, whether it would resolve publicly or not.
  if (ipLiteral(url.hostname)) return refused("FETCH_IP_LITERAL", `${url.hostname} is an IP literal; a locator names a host`);
  // P8.5, T8-009: the locator is checked decoded. The URL parser resolves `..` and `%2e%2e` segments away
  // before anything sees them, so the check reads the locator as written: its path, percent-decoded, may
  // have no dot segment and no encoded separator.
  const rawPath = locator.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/[?#].*$/s, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return refused("FETCH_URL", `${locator} has invalid percent-encoding`);
  }
  if (/%2f|%5c/i.test(rawPath) || decoded.split(/[/\\]/).some((s) => s === ".." || s === ".")) return refused("FETCH_PATH", `${locator} has a dot segment or an encoded separator once decoded`);
  try {
    const f = await safeFetch(url.href, { ...options, maxBytes: options.maxBytes ?? FETCH_CAPS[kind], timeoutMs: options.timeoutMs ?? OG_LIMITS.fetchMs });
    const input: EvidenceInput = kind === "signer-history" ? { kind, source: f.url, bytes: f.bytes, ...(options.did ? { did: options.did } : {}) } : { kind, source: f.url, bytes: f.bytes };
    return { status: "fetched", input, obtained: (options.now ?? (() => new Date()))().toISOString(), ...(f.mediaType ? { mediaType: f.mediaType } : {}) };
  } catch (error) {
    if (error instanceof OriginalsError) return refused(error.code, error.message);
    throw error;
  }
}
