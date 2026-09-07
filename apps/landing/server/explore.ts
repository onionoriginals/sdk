import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, verifyHistory } from '@originals/sdk/cel';
import { Ed25519Verifier } from '@originals/sdk';
import { resolveDIDFromLog } from 'didwebvh-ts';
import type { PublishedOriginal } from '../shared/explore';
import type { OriginalsStore } from './originals-store';
import { createRateLimiter } from './rate-limit';
import { json } from './router';

/** Read only the already-public hosted artifacts owned by each account. */
export function createExploreRoutes({
  store,
  dataDir,
  now = Date.now,
}: {
  store: OriginalsStore;
  dataDir: string;
  now?: () => number;
}) {
  const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
  let cache:
    | { host: string; until: number; rows: Promise<PublishedOriginal[]> }
    | undefined;

  async function catalogue(host: string): Promise<PublishedOriginal[]> {
    if (cache?.host === host && cache.until > now()) return cache.rows;
    const rows = (async () => {
      let users: string[];
      try {
        users = readdirSync(join(dataDir, 'users'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const found = new Map<string, PublishedOriginal>();
      for (const file of users.sort()) {
        if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) continue;
        const sub = file.slice(0, -5);
        try {
          for (const row of store.list(sub)) {
            try {
              const parts = row.did.split(':');
              if (
                parts[0] !== 'did' ||
                parts[1] !== 'webvh' ||
                decodeURIComponent(parts[3] ?? '') !== host
              )
                continue;
              const segments = parts.slice(4).map(decodeURIComponent);
              if (
                segments.some(
                  (s) => !s || s === '.' || s === '..' || /[\\/\0?#]/.test(s),
                )
              )
                continue;
              const path = segments.length ? segments.join('/') : '.well-known';
              const key = `${host}/${path}`;
              // A copied summary cannot discover another account's artifacts.
              const cel = store.read(sub, `${key}/cel.json`);
              const method = store.read(sub, `${key}/did.jsonl`);
              if (!cel.ok || !method.ok) continue;
              const state = verifyHistory(
                parseDocument(new Uint8Array(await cel.arrayBuffer()), 'json'),
              ).state;
              if (!state.active || !state.aliases.includes(row.did)) continue;
              const log = (await method.text())
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line));
              const resolved = await resolveDIDFromLog(log, {
                verifier: new Ed25519Verifier(),
              });
              if (
                resolved.did !== row.did ||
                resolved.doc?.id !== row.did ||
                resolved.meta.deactivated ||
                !resolved.doc.alsoKnownAs?.includes(state.didCel)
              )
                continue;
              const primary = state.resources[0];
              const urlPath =
                '/' + path.split('/').map(encodeURIComponent).join('/');
              const digest = primary?.digestMultibase;
              found.set(row.did, {
                did: row.did,
                assetDid: state.didCel,
                title: state.name || 'Untitled Original',
                createdAt: state.createdAt,
                controller: state.controller,
                resourceCount: state.resources.length,
                resourceHash: digest?.startsWith('u')
                  ? Buffer.from(digest.slice(1), 'base64url')
                      .subarray(2)
                      .toString('hex')
                  : '',
                ...(primary
                  ? {
                      resourceContentType: primary.mediaType,
                      resourceUrl: `${urlPath}/resources/${encodeURIComponent(primary.digestMultibase)}`,
                    }
                  : {}),
                logUrl: `${urlPath}/did.jsonl`,
                celUrl: `${urlPath}/cel.json`,
              });
            } catch {
              /* An invalid publication is not a public gallery entry. */
            }
          }
        } catch {
          /* Isolate corrupt/old account indexes; never return their contents. */
        }
      }
      return [...found.values()].sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.did.localeCompare(b.did),
      );
    })();
    cache = { host, until: now() + 15_000, rows };
    try {
      return await rows;
    } catch (e) {
      cache = undefined;
      throw e;
    }
  }

  return {
    async handle(
      req: Request,
      url: URL,
      clientIp = 'unknown',
    ): Promise<Response> {
      if (req.method !== 'GET')
        return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      const rate = limiter.check(clientIp);
      if (!rate.allowed)
        return json({ error: 'rate_limited' }, 429, {
          'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)),
        });
      const limitRaw = url.searchParams.get('limit') ?? '24';
      const offsetRaw = url.searchParams.get('offset') ?? '0';
      const q = (url.searchParams.get('q') ?? '').trim();
      if (
        !/^\d+$/.test(limitRaw) ||
        !/^\d+$/.test(offsetRaw) ||
        +limitRaw < 1 ||
        +limitRaw > 48 ||
        !Number.isSafeInteger(+offsetRaw) ||
        q.length > 150
      )
        return json({ error: 'bad_query' }, 400);
      try {
        const all = await catalogue(url.host);
        if (url.pathname === '/api/explore/original') {
          const original = all.find(
            (row) => row.did === url.searchParams.get('did'),
          );
          return original
            ? json({ original })
            : json({ error: 'not_found' }, 404);
        }
        const query = q.toLocaleLowerCase();
        const matches = query
          ? all.filter((row) =>
              [row.title, row.did, row.assetDid, row.controller].some((v) =>
                v.toLocaleLowerCase().includes(query),
              ),
            )
          : all;
        const offset = +offsetRaw,
          limit = +limitRaw;
        return json({
          originals: matches.slice(offset, offset + limit),
          total: matches.length,
          nextOffset: offset + limit < matches.length ? offset + limit : null,
        });
      } catch {
        return json({ error: 'explore_unavailable' }, 503);
      }
    },
  };
}
