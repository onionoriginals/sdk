/**
 * Hosted publication (plan 011, PR 7b; spec section 9).
 *
 * PROVISIONAL layout, relative to the alias did:webvh's `#files` base URL:
 *
 *   did.jsonl, did-witness.json      the did:webvh alias log, where did:webvh
 *                                    publishes it (.well-known/ for a bare domain)
 *   originals/...                    the Original's evidence package, unpacked
 *                                    (originals-evidence.json, asset/did.jsonl,
 *                                    signers/, resources/; no asset witness
 *                                    file: asset logs have none, P9.8)
 *
 * The files for one checkpoint are deterministic, so a retried publication
 * repeats the same snapshot and creates no transition (P9.2). The public
 * reader (`OriginalsSDK.loadPublished`) verifies that exact snapshot (P9.1).
 */
import { OriginalsError } from "@originals/vh";
import { FETCH_LIMITS } from "@originals/vh/fetch";
import type { AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl, didWebvhLogUrl } from "@originals/vh/webvh";
import { readZip } from "./zip.js";

/**
 * What `loadPublished` allows one request (issue #970). A fetcher should
 * honour all three; `safeFetch` accepts them as its options. One that ignores
 * them is still bounded: the SDK checks the size it returns and stops waiting
 * when the request's time or the whole operation's runs out.
 */
export interface HostedFetchOptions {
  /**
   * The most bytes the response may have: the per-file cap or what is left of
   * the whole-operation byte budget, whichever is smaller. A larger response
   * should be refused with the code FETCH_TOO_LARGE, as `safeFetch` does.
   */
  maxBytes: number;
  /** How long this request may take: its own timeout or what is left of the whole operation's, whichever is shorter. */
  timeoutMs: number;
  /** Aborted when the request's time runs out, at the whole-operation deadline or when the caller aborts. */
  signal: AbortSignal;
}

/**
 * Retrieve one hosted file, or throw an `unavailable-bytes` OriginalsError.
 * A refusal may report the body bytes it had already read as
 * `details.bytesRead` (`safeFetch` does); they count against
 * `RetrievalLimits.maxTotalBytes`.
 * `@originals/vh/fetch`'s `safeFetch` fits:
 * `async (url, options) => (await safeFetch(url, options)).bytes`.
 */
export type HostedFetch = (url: string, options: HostedFetchOptions) => Promise<Uint8Array>;

/**
 * Whole-operation bounds on `loadPublished` (issue #970). PROVISIONAL: these
 * are implementation limits, not protocol rules. Exhausting one is a
 * `limit-exceeded` OriginalsError, RETRIEVAL_BUDGET_EXCEEDED, never a result.
 */
export interface RetrievalLimits {
  /**
   * Requests in one call, failed and optional ones included. The plan
   * derived from the asset log (each signer's log and witness, each
   * resource) must fit before any of it is requested.
   */
  maxRequests?: number;
  /**
   * Bytes accepted in one call, counted as responses arrive: the alias log
   * and witness as well as the snapshot. Defaults to the SDK's
   * `archiveLimits.maxTotalBytes` (else `ZIP_LIMITS.maxTotalBytes`), the most
   * `load` accepts in one package; the snapshot's own files are also held to
   * that archive limit, and their number to `archiveLimits.maxEntries`.
   */
  maxTotalBytes?: number;
  /** Bytes in one response other than a resource. Defaults to `FETCH_LIMITS.maxBytes`, the profile's 16 MiB log-file cap (P7.7). */
  maxFileBytes?: number;
  /**
   * Bytes in one resource response. Defaults to `FETCH_LIMITS.maxResourceBytes`,
   * 64 MiB (P8.5; P14.13, PROVISIONAL, section 14). A larger resource
   * is unavailable content, never a failure (P7.4).
   */
  maxResourceBytes?: number;
  /** Milliseconds for one request. Defaults to `FETCH_LIMITS.timeoutMs`. */
  requestTimeoutMs?: number;
  /** Milliseconds for the whole call, so slow or absent optional files cannot multiply the per-request timeout. */
  timeoutMs?: number;
}

/** PROVISIONAL defaults for `RetrievalLimits`; `maxTotalBytes` follows the archive limits. */
export const RETRIEVAL_LIMITS = Object.freeze({
  maxRequests: 1_024,
  maxFileBytes: FETCH_LIMITS.maxBytes,
  maxResourceBytes: FETCH_LIMITS.maxResourceBytes,
  requestTimeoutMs: FETCH_LIMITS.timeoutMs,
  timeoutMs: 120_000,
});

export const HOSTED_PREFIX = "originals/";

/** Where the alias log sits relative to the `#files` base. */
export function aliasLogPath(aliasDid: string): string {
  return didWebvhLogUrl(aliasDid).slice(didWebvhFilesUrl(aliasDid).length);
}

/**
 * Refuse hosted publication of a log any of whose resources is larger than a
 * hosted reader fetches: 64 MiB, `FETCH_LIMITS.maxResourceBytes` (P8.5; P14.13,
 * PROVISIONAL, section 14). No reader could retrieve it, so
 * it is refused before anything is published (limit-exceeded,
 * RESOURCE_OVER_FETCH_LIMIT, naming the resource). A local Original is never
 * fetched, so creating and editing one are not limited.
 */
export function assertHostable(log: string): void {
  for (const line of log.split("\n")) {
    let resources: unknown;
    try {
      resources = (JSON.parse(line) as { state?: { asset?: { resources?: unknown } } }).state?.asset?.resources;
    } catch {
      continue; // Verification reports a malformed line.
    }
    if (!Array.isArray(resources)) continue;
    for (const r of resources as Array<{ id?: unknown; digest?: unknown; size?: unknown }>) {
      if (typeof r?.size === "number" && r.size > FETCH_LIMITS.maxResourceBytes) {
        throw new OriginalsError("limit-exceeded", "RESOURCE_OVER_FETCH_LIMIT", `resource ${String(r.id)} is ${r.size} bytes; a hosted reader fetches at most ${FETCH_LIMITS.maxResourceBytes}`, {
          resource: r.id, digest: r.digest, size: r.size, limit: FETCH_LIMITS.maxResourceBytes,
        });
      }
    }
  }
}

/**
 * The files a host serves for an Original's checkpoint, by path relative to the
 * alias's `#files` base. A resource no hosted reader could fetch is refused
 * (`assertHostable`).
 */
export async function hostedFiles(
  sdk: { package(did: string, options?: { checkpoint?: string }): Promise<{ bytes: Uint8Array }> },
  did: string,
  alias: AliasEvidence,
  options: { checkpoint?: string } = {},
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const logPath = aliasLogPath(alias.did);
  files.set(logPath, encoder.encode(typeof alias.log === "string" ? alias.log : alias.log.map((e) => `${JSON.stringify(e)}\n`).join("")));
  if (alias.witness !== undefined) files.set(logPath.replace(/did\.jsonl$/, "did-witness.json"), encoder.encode(JSON.stringify(alias.witness)));
  const packaged = readZip((await sdk.package(did, options)).bytes);
  const log = packaged.get("asset/did.jsonl");
  if (log) assertHostable(new TextDecoder().decode(log));
  for (const [path, data] of packaged) files.set(`${HOSTED_PREFIX}${path}`, data);
  return files;
}

const ACTIVE = /^(?:text\/html|text\/xml|text\/xsl|text\/javascript|image\/svg\+xml|application\/(?:xml|xhtml\+xml|[\w.-]+\+xml|javascript|ecmascript|pdf))\b/i;

/**
 * Response headers for serving a resource (P9.7): its signed media type, no
 * content-type sniffing, and a policy that runs no script and sandboxes the
 * document. Active content (HTML, SVG, XML, script) is also marked as an
 * attachment for navigations. The host must still serve resources from an
 * origin without user credentials.
 */
export function servingHeaders(mediaType: string): Record<string, string> {
  return {
    "Content-Type": mediaType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    ...(ACTIVE.test(mediaType) ? { "Content-Disposition": "attachment" } : {}),
  };
}
