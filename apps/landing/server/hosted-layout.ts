/**
 * The keys a signed-in author may write to the durable host, and the content
 * type each is served with (plan 011, PR 8; layout from @originals/sdk's
 * hostedFiles, PROVISIONAL).
 *
 *   <host>/<user-slug>/did.jsonl                       the author's own did:webvh
 *   <host>/<user-slug>/o-<name>/did.jsonl              an Original's did:webvh alias
 *   <host>/<user-slug>/o-<name>/did-witness.json       its did:webvh witness file
 *   <host>/<user-slug>/o-<name>/originals/<file>       the Original's evidence package,
 *                                                      unpacked (originals-evidence.json,
 *                                                      asset/did.jsonl, asset/did-witness.json,
 *                                                      authors/<64 hex>/did.jsonl|did-witness.json,
 *                                                      resources/<digest>)
 *
 * Every write is inside the caller's own namespace, so no shape can shadow the
 * app's static assets or another author's files. A key holds no `%` or `\`,
 * because the store decodes it once more. The server assigns every content
 * type itself: a resource is served with the media type its descriptor
 * declares in the uploaded asset log, never a header the uploader chose
 * (P9.7). The host does not verify that log; readers do.
 */
import { resourceDigest } from '@originals/vh/originals';

const NAME = /^o-[1-9A-HJ-NP-Za-km-z]{16}$/;
const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`, 'i');
// A bare `type/subtype` (RFC 6838 restricted names), with no parameters.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export type HostedKey =
  | { kind: 'identity-log' }
  | { kind: 'alias-log' | 'alias-witness' }
  | { kind: 'evidence'; contentType: string }
  | { kind: 'resource'; digest: string; assetLogKey: string };

/** Classify `key` for the author whose namespace is `slug`, or null when it is not a hosted file of theirs. */
export function classifyHostedKey(key: string, slug: string): HostedKey | null {
  if (/[%\\]/.test(key)) return null;
  const [host, ns, ...rest] = key.split('/');
  if (!host || !HOST.test(host) || ns !== slug || rest.length === 0) return null;
  if (rest.length === 1 && rest[0] === 'did.jsonl') return { kind: 'identity-log' };
  const [name, ...file] = rest;
  if (!NAME.test(name)) return null;
  if (file.length === 1 && file[0] === 'did.jsonl') return { kind: 'alias-log' };
  if (file.length === 1 && file[0] === 'did-witness.json') return { kind: 'alias-witness' };
  if (file[0] !== 'originals') return null;
  const p = file.slice(1);
  const json = { kind: 'evidence' as const, contentType: 'application/json' };
  const jsonl = { kind: 'evidence' as const, contentType: 'application/jsonl' };
  if (p.length === 1 && p[0] === 'originals-evidence.json') return json;
  if (p.length === 2 && p[0] === 'asset' && p[1] === 'did.jsonl') return jsonl;
  if (p.length === 2 && p[0] === 'asset' && p[1] === 'did-witness.json') return json;
  if (p.length === 3 && p[0] === 'authors' && HEX64.test(p[1]) && p[2] === 'did.jsonl') return jsonl;
  if (p.length === 3 && p[0] === 'authors' && HEX64.test(p[1]) && p[2] === 'did-witness.json') return json;
  if (p.length === 2 && p[0] === 'resources' && DIGEST.test(p[1])) {
    return { kind: 'resource', digest: p[1], assetLogKey: [host, ns, name, 'originals', 'asset', 'did.jsonl'].join('/') };
  }
  return null;
}

/** The content type the server assigns to a non-resource file. */
export function hostedContentType(k: Exclude<HostedKey, { kind: 'resource' }>): string {
  if (k.kind === 'evidence') return k.contentType;
  return k.kind === 'alias-witness' ? 'application/json' : 'application/jsonl';
}

/**
 * The media type the uploaded asset log's descriptors give `digest`, or null
 * when no entry lists it or the latest one is not a bare `type/subtype`. The
 * host does not verify the log; the public reader does. This only decides how
 * the host labels bytes it already holds.
 */
export function signedMediaType(assetLog: string, digest: string): string | null {
  let found: string | null = null;
  for (const line of assetLog.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { state?: { asset?: { resources?: Array<{ digest?: unknown; mediaType?: unknown }> } } };
      for (const r of entry.state?.asset?.resources ?? []) {
        if (r.digest === digest) found = typeof r.mediaType === 'string' && MEDIA_TYPE.test(r.mediaType) ? r.mediaType : null;
      }
    } catch {
      return null;
    }
  }
  return found;
}

/** True when `bytes` are the bytes `digest` names. */
export function bytesMatchDigest(bytes: Uint8Array, digest: string): boolean {
  return resourceDigest(bytes) === digest;
}
