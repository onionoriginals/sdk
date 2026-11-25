import { parseDidWebvh, type DidWebvhParts } from '@originals/vh/webvh';

/** Hosted layout: same directory as `did.jsonl`, with `tsp/inbox` as the POST target. */
export const TSP_INBOX_SUFFIX = 'tsp/inbox';
const PLACEHOLDER_SCID = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';

function encodeSegment(segment: string): string {
  return Array.from(new TextEncoder().encode(segment), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9._~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join('');
}

function origin(parts: DidWebvhParts): string {
  return `https://${parts.host}${parts.port ? `:${parts.port}` : ''}`;
}

export function webvhTspInboxUrl(did: string): string {
  const parts = parseDidWebvh(did);
  const path = parts.path.map(encodeSegment).join('/');
  return `${origin(parts)}/${path ? `${path}/` : '.well-known/'}${TSP_INBOX_SUFFIX}`;
}

export function webvhTspInboxPathname(did: string): string {
  return new URL(webvhTspInboxUrl(did)).pathname;
}

/** Inbox URL from publishing address before the SCID is known. */
export function webvhTspInboxUrlFromPublishingAddress(
  domain: string,
  pathSegments: string[] = [],
): string {
  const suffix = pathSegments.length
    ? `:${pathSegments.map(encodeSegment).join(':')}`
    : '';
  return webvhTspInboxUrl(`did:webvh:${PLACEHOLDER_SCID}:${domain}${suffix}`);
}

export function tspInboxPathMatches(did: string, requestUrl: string | URL): boolean {
  const req = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  const want = webvhTspInboxPathname(did);
  const got = req.pathname.replace(/\/{2,}/g, '/');
  return got === want;
}