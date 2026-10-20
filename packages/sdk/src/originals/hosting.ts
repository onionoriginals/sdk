/**
 * Hosted publication (plan 011, PR 7b; spec section 9).
 *
 * PROVISIONAL layout, relative to the alias did:webvh's `#files` base URL:
 *
 *   did.jsonl, did-witness.json      the did:webvh alias log, where did:webvh
 *                                    publishes it (.well-known/ for a bare domain)
 *   originals/...                    the Original's evidence package, unpacked
 *                                    (originals-evidence.json, asset/, authors/,
 *                                    resources/)
 *
 * The files for one checkpoint are deterministic, so a retried publication
 * repeats the same snapshot and creates no transition (P9.2). The public
 * reader (`OriginalsSDK.loadPublished`) verifies that exact snapshot (P9.1).
 */
import type { AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl, didWebvhLogUrl } from "@originals/vh/webvh";
import { readZip } from "./zip.js";

/** Retrieve one hosted file, or throw an `unavailable-bytes` OriginalsError. `@originals/vh/fetch`'s `safeFetch` fits. */
export type HostedFetch = (url: string) => Promise<Uint8Array>;

export const HOSTED_PREFIX = "originals/";

/** Where the alias log sits relative to the `#files` base. */
export function aliasLogPath(aliasDid: string): string {
  return didWebvhLogUrl(aliasDid).slice(didWebvhFilesUrl(aliasDid).length);
}

/** The files a host serves for an Original's checkpoint, by path relative to the alias's `#files` base. */
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
  for (const [path, data] of readZip((await sdk.package(did, options)).bytes)) files.set(`${HOSTED_PREFIX}${path}`, data);
  return files;
}

const ACTIVE = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript)\b/i;

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
