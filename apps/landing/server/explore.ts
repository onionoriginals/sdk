import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, verifyHistory, sameAssetIdentity, parseAssetAlias } from '@originals/sdk/cel';
import type { SatSnapshot } from '@originals/sdk/cel';
import { Ed25519Verifier, validateSatoshiNumber } from '@originals/sdk';
import { resolveDIDFromLog } from 'didwebvh-ts';
import type { PublishedOriginal } from '../shared/explore';
import type { OriginalsStore } from './originals-store';
import { createRateLimiter } from './rate-limit';
import { json } from './router';
import { encodeSatSnapshot, snapshotContentBytes } from './sat-snapshot-codec';

/**
 * Read-only capability this route needs — never the full money-path
 * OrdinalsProvider. Optional, matching `OrdinalsProvider`/`FaucetProvider`'s
 * own optional `getSatSnapshot`, so either can be passed directly.
 */
export interface ExploreSatProvider {
  getSatSnapshot?(sat: string): Promise<SatSnapshot>;
}

/**
 * The public, unauthenticated sat-snapshot route's own content bound — well
 * above anything this app's own demo ever produces (its upload cap is 32
 * KiB, see src/sdk/source-file.ts), but far under the protocol's 32 MiB
 * per-asset ceiling, so a permitted large publication cannot turn one public
 * request into an outsized response.
 */
const PUBLIC_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

const isCanonicalSatoshi = (sat: string): boolean =>
  /^(0|[1-9]\d*)$/.test(sat) && validateSatoshiNumber(sat).valid;

/** Read only the already-public hosted artifacts owned by each account. */
export function createExploreRoutes({
  store,
  dataDir,
  satProvider,
  now = Date.now,
}: {
  store: OriginalsStore;
  dataDir: string;
  /**
   * Bounded, unauthenticated Bitcoin read access for the public cold-start
   * verifier (`/explore/<did>`) to independently resolve an Original's
   * accepted on-sat history — never funding, signing or broadcast
   * capability, and never the authenticated `/api/btc/*` money path. Absent
   * on a deploy without Bitcoin configured, which degrades this route to
   * `sat_snapshot_unsupported` rather than disabling Explore entirely.
   */
  satProvider?: ExploreSatProvider;
  now?: () => number;
}) {
  const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
  // Bitcoin node reads are far more expensive than the in-memory catalogue, so
  // this is bounded independently and more tightly — a public, unauthenticated
  // caller must not be able to use this to flood the configured node/indexer.
  const satLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
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
                !resolved.doc.alsoKnownAs?.some((alias: string) => sameAssetIdentity(alias, state.assetId))
              )
                continue;
              const primary = state.resources[0];
              const urlPath =
                '/' + path.split('/').map(encodeURIComponent).join('/');
              const digest = primary?.digestMultibase;
              // The most-recent btco alias, if this Original has migrated to
              // Bitcoin — aliases accumulate in cel → webvh → btco order, so
              // the last one that parses as a btco layer is the current sat.
              let sat: string | undefined;
              for (const alias of state.aliases) {
                try {
                  const parsed = parseAssetAlias(alias);
                  if (parsed.layer === 'btco') sat = parsed.sat;
                } catch {
                  /* Not every alias need parse under every alias grammar. */
                }
              }
              // The normal Bitcoin writer enriches the account index without
              // rewriting hosted CEL. This is only a discovery hint: the browser
              // must bind a fresh on-sat resolution to the verified hosted asset.
              if (sat === undefined && typeof row.satoshi === 'string' &&
                  isCanonicalSatoshi(row.satoshi)) {
                sat = row.satoshi;
              }
              found.set(row.did, {
                did: row.did,
                assetId: state.assetId,
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
                ...(sat ? { sat } : {}),
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
      if (url.pathname.startsWith('/api/explore/sat-snapshot/')) {
        const satLimit = satLimiter.check(clientIp);
        if (!satLimit.allowed)
          return json({ error: 'rate_limited' }, 429, {
            'Retry-After': String(Math.ceil(satLimit.retryAfterMs / 1000)),
          });
        const sat = url.pathname.slice('/api/explore/sat-snapshot/'.length);
        if (!isCanonicalSatoshi(sat))
          return json({ error: 'bad_request' }, 400);
        if (typeof satProvider?.getSatSnapshot !== 'function')
          return json({ error: 'sat_snapshot_unsupported' }, 501);
        try {
          const snapshot = await satProvider.getSatSnapshot(sat);
          // An asset's own content is protocol-permitted up to 32 MiB — fine
          // for an authenticated, per-user-quota'd caller, but this route is
          // public and unauthenticated (only IP rate-limited), so serializing
          // that much content on every permitted request would let a single
          // caller repeatedly force large responses and large intermediate
          // allocations. Reject before encoding rather than after.
          if (snapshotContentBytes(snapshot) > PUBLIC_SNAPSHOT_MAX_BYTES)
            return json({ error: 'snapshot_too_large' }, 413);
          return json(encodeSatSnapshot(snapshot));
        } catch {
          return json({ error: 'sat_snapshot_unavailable' }, 502);
        }
      }
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
              [row.title, row.did, row.assetId, row.controller].some((v) =>
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
