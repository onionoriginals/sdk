/**
 * Durable, filesystem-backed store for signed-in users' Originals.
 *
 * Two trees under `dataDir`:
 *   hosted/<host>/<path>      the did:webvh log / cel / resource bytes (public;
 *                             served at the resolver's exact URL). A sibling
 *                             <file>.ctype holds the content-type so serve()
 *                             survives a restart.
 *   users/<sub>.json          per-user index { originals, sizes, totalBytes }.
 *
 * Everything reads/writes disk directly, so a fresh store on the same dir sees
 * all prior data (restart durability). Keys are `${domain}/${relativePath}` —
 * identical to the ephemeral host adapter — so serve() looks up
 * `${url.host}${url.pathname}`, byte-identical to the put key.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { untrustedHeaders } from './webvh-host';

export interface OriginalSummary {
  did: string;
  title: string;
  resourceHash: string;
  createdAt: string;
  /** Derived (not stored): the resolvable URL of the artwork resource, for the thumbnail. */
  resourceUrl?: string;
}

interface UserIndex {
  originals: Array<{ did: string; title: string; resourceHash: string; createdAt: string }>;
  sizes: Record<string, number>;
  totalBytes: number;
}

export interface OriginalsStore {
  saveBytes(subOrgId: string, key: string, bytes: Uint8Array, contentType: string): void;
  recordOriginal(
    subOrgId: string,
    o: { did: string; title: string; resourceHash: string; createdAt: string }
  ): void;
  list(subOrgId: string): OriginalSummary[];
  serve(url: URL): Response | null;
  /** Auth-scoped read by object key (adapter.get) — only keys this user wrote. */
  read(subOrgId: string, key: string): Response;
}

const CTYPE_SUFFIX = '.ctype';

/** Split a key into safe segments, rejecting empty / dot / traversal segments. */
function keySegments(key: string): string[] {
  const segs = decodeURIComponent(key).split('/').filter((s) => s.length > 0);
  if (segs.length === 0) throw new Error('BAD_KEY');
  for (const s of segs) {
    if (s === '.' || s === '..' || s.includes('\0')) throw new Error('BAD_KEY');
  }
  return segs;
}

/** Absolute path under baseDir for a key; throws if it would escape baseDir. */
function keyToPath(baseDir: string, key: string): string {
  const abs = resolve(baseDir, ...keySegments(key));
  const root = resolve(baseDir) + sep;
  if (!abs.startsWith(root)) throw new Error('BAD_KEY');
  return abs;
}

/** A subOrgId used as a filename — Turnkey sub-orgs are UUID-safe; reject anything else. */
function subFile(dataDir: string, subOrgId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(subOrgId)) throw new Error('BAD_KEY');
  return join(dataDir, 'users', `${subOrgId}.json`);
}

export function createOriginalsStore(opts: {
  dataDir: string;
  maxOriginals?: number;
  maxTotalBytes?: number;
}): OriginalsStore {
  const dataDir = opts.dataDir;
  const maxOriginals = opts.maxOriginals ?? 100;
  const maxTotalBytes = opts.maxTotalBytes ?? 25 * 1024 * 1024; // 25 MiB / user
  const hostedDir = join(dataDir, 'hosted');

  function readIndex(subOrgId: string): UserIndex {
    const path = subFile(dataDir, subOrgId);
    if (!existsSync(path)) return { originals: [], sizes: {}, totalBytes: 0 };
    return JSON.parse(readFileSync(path, 'utf8')) as UserIndex;
  }

  function writeIndex(subOrgId: string, idx: UserIndex): void {
    const path = subFile(dataDir, subOrgId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(idx));
  }

  function saveBytes(subOrgId: string, key: string, bytes: Uint8Array, contentType: string): void {
    const target = keyToPath(hostedDir, key); // validates traversal
    const idx = readIndex(subOrgId);
    const prev = idx.sizes[key] ?? 0;
    const nextTotal = idx.totalBytes - prev + bytes.byteLength;
    if (nextTotal > maxTotalBytes) throw new Error('STORE_FULL');

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    writeFileSync(target + CTYPE_SUFFIX, contentType);

    idx.sizes[key] = bytes.byteLength;
    idx.totalBytes = nextTotal;
    writeIndex(subOrgId, idx);
  }

  function recordOriginal(
    subOrgId: string,
    o: { did: string; title: string; resourceHash: string; createdAt: string }
  ): void {
    const idx = readIndex(subOrgId);
    // Idempotent: a best-effort record retry (POST timed out, user re-published)
    // must not list the same did twice.
    if (idx.originals.some((e) => e.did === o.did)) return;
    if (idx.originals.length >= maxOriginals) throw new Error('STORE_FULL');
    idx.originals.push(o);
    writeIndex(subOrgId, idx);
  }

  // did:webvh:<SCID>:<host>[:<seg>…] → the resource-key prefix `${host}/${segs}/resources/`.
  function resourcePrefix(did: string): string | null {
    const parts = did.split(':');
    if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') return null;
    const host = decodeURIComponent(parts[3] ?? '');
    const segs = parts.slice(4).map((s) => decodeURIComponent(s));
    return segs.length ? `${host}/${segs.join('/')}/resources/` : `${host}/resources/`;
  }

  function list(subOrgId: string): OriginalSummary[] {
    const idx = readIndex(subOrgId);
    const keys = Object.keys(idx.sizes);
    return idx.originals.map((o) => {
      const prefix = resourcePrefix(o.did);
      const resourceKey = prefix ? keys.find((k) => k.startsWith(prefix)) : undefined;
      return { ...o, resourceUrl: resourceKey ? `https://${resourceKey}` : undefined };
    });
  }

  function serve(url: URL): Response | null {
    const key = `${url.host}${url.pathname}`;
    if (key.endsWith(CTYPE_SUFFIX)) return null; // never serve the sidecars
    let path: string;
    try {
      path = keyToPath(hostedDir, key);
    } catch {
      return null; // traversal or bad key → miss, never escapes the dir
    }
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    const contentType = existsSync(path + CTYPE_SUFFIX)
      ? readFileSync(path + CTYPE_SUFFIX, 'utf8')
      : 'application/octet-stream';
    return new Response(new Uint8Array(bytes), { status: 200, headers: untrustedHeaders(contentType) });
  }

  // adapter.get: read back an object the user themselves wrote. Scoped to the
  // user's index (keys in idx.sizes) so it never reads another user's bytes.
  // 404 → the adapter returns null (its "not found" contract); other bytes 200.
  function read(subOrgId: string, key: string): Response {
    const idx = readIndex(subOrgId);
    if (!(key in idx.sizes)) return new Response('Not found', { status: 404 });
    let path: string;
    try {
      path = keyToPath(hostedDir, key);
    } catch {
      return new Response('Bad key', { status: 400 });
    }
    if (!existsSync(path)) return new Response('Not found', { status: 404 });
    const bytes = readFileSync(path);
    const contentType = existsSync(path + CTYPE_SUFFIX)
      ? readFileSync(path + CTYPE_SUFFIX, 'utf8')
      : 'application/octet-stream';
    return new Response(new Uint8Array(bytes), { status: 200, headers: untrustedHeaders(contentType) });
  }

  return { saveBytes, recordOriginal, list, serve, read };
}
