/**
 * did:og shared-host saves over HTTP (P6.7, P6.2, P9.7, P14.11), on a durable
 * file store. Bun runtime. Routes:
 *
 *   POST /og/saves                          a submission (section 14, "Shared-host saves")
 *   GET  /og/<SCID>/did.jsonl               the accepted asset log, byte for byte
 *   GET  /og/<SCID>/resources/<digest>      a resource version, with its signed media type (P9.7)
 *
 * The JSON body is `{original, entry, resources: [{digest, bytes}], identities: [{did, log}]}`,
 * with `bytes` in base64 (the spec needs no particular transport). The four answers are
 * 201 accepted, 200 already-accepted, 409 stale-parent and 422 rejected (P6.7, T6-030).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { parseLogFile, resourceHeaders, SharedHost, stateOf, type HostStore, type OgEntry, type Submission } from '@originals/vh/og';
import type { Handler } from './router.js';

const SCID = /^[1-9A-HJ-NP-Za-km-z]{46}$/;
const DIGEST = /^zQm[1-9A-HJ-NP-Za-km-z]{44}$/;

function durableWrite(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** A HostStore on the file system: every write is synced before it resolves (P6.2, P6.7). */
export function ogFileStore(dataDir: string): HostStore {
  const scidOf = (original: string) => {
    const scid = original.startsWith('did:og:') ? original.slice(7) : '';
    if (!SCID.test(scid)) throw new Error('not a did:og');
    return scid;
  };
  const logPath = (o: string) => join(dataDir, 'og', scidOf(o), 'did.jsonl');
  const read = (p: string) => (existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined);
  return {
    readLog: (o) => Promise.resolve(read(logPath(o)) && new TextDecoder().decode(read(logPath(o)))),
    createLog: (o, line) => Promise.resolve(durableWrite(logPath(o), line)),
    appendLine: (o, line) => {
      const fd = openSync(logPath(o), 'a');
      try {
        writeSync(fd, Buffer.from(line));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return Promise.resolve();
    },
    putResource: (o, d, b) => Promise.resolve(durableWrite(join(dataDir, 'og', scidOf(o), 'resources', d), b)),
    getResource: (o, d) => Promise.resolve(DIGEST.test(d) ? read(join(dataDir, 'og', scidOf(o), 'resources', d)) : undefined),
    putIdentity: (did, log) => Promise.resolve(durableWrite(join(dataDir, 'og-identities', `${bytesToHex(sha256(new TextEncoder().encode(did)))}.jsonl`), log)),
    getIdentity: (did) => {
      const b = read(join(dataDir, 'og-identities', `${bytesToHex(sha256(new TextEncoder().encode(did)))}.jsonl`));
      return Promise.resolve(b && new TextDecoder().decode(b));
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } });

/** The did:og routes over a store. A body over `maxBodyBytes` (default 80 MiB) is refused. */
export function createOgRoutes(deps: { store: HostStore; maxBodyBytes?: number }): Handler {
  const host = new SharedHost(deps.store);
  const max = deps.maxBodyBytes ?? 80 * 1024 * 1024;
  return async (req, url) => {
    if (url.pathname === '/og/saves' && req.method === 'POST') {
      const text = await req.text();
      if (text.length > max) return json(413, { error: 'body too large' });
      let body: { original: string; entry: string; resources?: Array<{ digest: string; bytes: string }>; identities?: Array<{ did: string; log: string }> };
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { error: 'body is not JSON' });
      }
      if (typeof body?.original !== 'string' || typeof body.entry !== 'string') return json(400, { error: 'original and entry are required' });
      const submission: Submission = {
        original: body.original,
        entry: body.entry,
        resources: (body.resources ?? []).map((r) => ({ digest: r.digest, bytes: base64.decode(r.bytes) })),
        identities: body.identities ?? [],
      };
      const r = await host.submit(submission);
      return json(r.result === 'accepted' ? 201 : r.result === 'already-accepted' ? 200 : r.result === 'stale-parent' ? 409 : 422, r);
    }
    const m = /^\/og\/([1-9A-HJ-NP-Za-km-z]{46})\/(did\.jsonl|resources\/(zQm[1-9A-HJ-NP-Za-km-z]{44}))$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const original = `did:og:${m[1]}`;
      const log = await deps.store.readLog(original);
      if (!log) return json(404, { error: 'not found' });
      if (m[2] === 'did.jsonl') return new Response(log, { headers: { 'content-type': 'application/jsonl', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } });
      const bytes = await deps.store.getResource(original, m[3]);
      if (!bytes) return json(404, { error: 'not found' });
      // The signed media type of the version with that digest (P9.7), never sniffed.
      const entries = parseLogFile(log).values as OgEntry[];
      const named = [...entries].reverse().find((e) => stateOf(e).asset.resource.digest === m[3]);
      const type = named ? stateOf(named).asset.resource.mediaType : 'application/octet-stream';
      return new Response(bytes, { headers: { ...lower(resourceHeaders(type)), 'access-control-allow-origin': '*' } });
    }
    return json(404, { error: 'not found' });
  };
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
