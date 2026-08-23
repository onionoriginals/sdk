/**
 * In-memory WebVH host: receives the SDK's hosting writes at PUT /api/host/<key>
 * and serves them back at the EXACT URLs didwebvh-ts's resolver GETs.
 *
 * The put key is `${domain}/${relativePath}` (LifecycleManager). The resolver
 * GETs https://${domain}/${relativePath}, so on serve the lookup key is
 * `${url.host}${url.pathname}` — byte-identical to the put key. Bounded by a
 * per-object size cap, per-client and global entry caps, a total-bytes budget,
 * and a TTL; PUTs are rate-limited.
 *
 * Capacity is EVICTION, not refusal (R15). The old behaviour answered 507 at a
 * global cap, so the first visitor to fill the store broke publishing for
 * everyone until the TTL drained it. Two properties make eviction safe on a
 * route that is unauthenticated with client-chosen keys:
 *
 *   1. The budget is PER WRITER. Plain global LRU as the FIRST line would hand
 *      an attacker a cheap eviction primitive — flood, and other visitors'
 *      published logs are the ones deleted. A flooding client spends its own
 *      budget and evicts its own entries. Above that budget there is still a
 *      process-wide entry/byte ceiling, and reaching it DOES evict the
 *      least-recently-active other client's group (dropGlobalLru): a real
 *      memory bound on a single-instance server, and one that takes many
 *      distinct client identities to reach, not one flooding socket.
 *   2. The unit is a PUBLISH GROUP, not an object — for OWNERSHIP as well as
 *      for eviction. One publish writes several objects that only mean anything
 *      together (did.jsonl + cel.json + the resource bytes the resolver
 *      fetches). Evicting one member would turn an honest write-time refusal
 *      into a silently unresolvable DID at read time. So a group is charged to
 *      one budget for its whole life (R5): a revision arriving from a second
 *      identity — a visitor on mobile or IPv6 whose egress address rotated
 *      between publish and revision — joins the group's existing owner instead
 *      of re-parenting that one key, which used to split a publish across two
 *      budgets whose halves then evicted independently. Groups go whole, so a
 *      surviving log never points at bytes that are gone.
 *
 * Recency is tracked on READS as well as writes, which makes read() and serve()
 * mutate the bookkeeping maps — deliberate, so a log someone is actively
 * resolving is the last thing to go.
 */
import { json } from './router';
import { createRateLimiter } from './rate-limit';

interface Entry {
  body: Uint8Array;
  contentType: string;
  expiresAt: number;
  /** The owner of this object's group — whose budget it charges. See groupOwners. */
  client: string;
  /** The publish this object belongs to; the unit ownership and eviction operate on. */
  group: string;
}

const HOST_PREFIX = '/api/host/';

/**
 * Capacity numbers, revisited together now that a full store evicts instead of
 * refusing. They bound MEMORY; the TTL now only bounds staleness.
 *
 * - 64 entries per client ≈ 15 publishes for one visitor (a publish is ~4
 *   objects), so a real session — create, publish, several revisions — never
 *   evicts its own work, and a flood evicts only its own.
 * - 4,000 entries and 64 MiB globally are the process-wide ceiling; at the
 *   ~5 KB an actual demo object weighs that is ~800 concurrent sessions, well
 *   past launch traffic. The byte budget is the real bound, since maxObjectBytes
 *   is 256 KiB and a count alone would allow ~1 GiB.
 * - 2,000 client identities bounds the bookkeeping map itself (same reasoning
 *   as rate-limit.ts: unauthenticated route, IPv6 rotation is cheap).
 * - The TTL is 2 hours, up from 30 minutes: eviction now bounds memory, so the
 *   TTL is free to be long enough that a shared "open the signed DID log" link
 *   still resolves after the visitor walks away from it.
 */
const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES_PER_CLIENT = 64;
const DEFAULT_MAX_ENTRIES = 4_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CLIENTS = 2_000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

// The tail of a key that identifies it as a member of a did:webvh publish
// rather than the publish root. Mirrors LifecycleManager.webvhStorageLocation /
// webvhResourceLocation: `{domain}/{userPath}/{did.jsonl|cel.json}` and
// `{domain}/{userPath}/resources/{multibase}`, with the pathless DID writing
// its log under `.well-known` while its resources stay at the domain root.
const GROUP_MEMBER_SUFFIX = /\/(?:resources\/[^/]+|did\.jsonl|did\.json|cel\.jsonl|cel\.json)$/;

/**
 * The publish a stored object belongs to. Unrecognised keys are their own group
 * — folding an unknown layout into a neighbour would let one key's eviction
 * take out another publish's bytes, the exact failure groups exist to prevent.
 */
export function publishGroupOf(key: string): string {
  const base = key.replace(GROUP_MEMBER_SUFFIX, '');
  if (base === key) return key;
  return base.replace(/\/\.well-known$/, '') || key;
}

export function createWebvhHostStore(opts?: {
  maxObjectBytes?: number;
  maxEntriesPerClient?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxClients?: number;
  ttlMs?: number;
  now?: () => number;
  limit?: number;
  windowMs?: number;
}) {
  const maxObjectBytes = opts?.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  // At least 1: a cap of 0 would make the eviction loop unable to terminate on
  // a write it must still accept.
  const perClientCap = Math.max(1, opts?.maxEntriesPerClient ?? DEFAULT_MAX_ENTRIES_PER_CLIENT);
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxClients = opts?.maxClients ?? DEFAULT_MAX_CLIENTS;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  // 120 writes/min PER CLIENT (was per socket peer, i.e. one site-wide bucket
  // behind the proxy — roughly twenty publishes/min for the whole site). One
  // publish issues a handful of writes (DID log + CEL + resources), so this is
  // ~20 publishes/min for a single visitor: generous for a human, still a cap
  // on an unauthenticated flood, and the size and entry caps below bound what
  // those writes can cost.
  const limiter = createRateLimiter({
    limit: opts?.limit ?? 120,
    windowMs: opts?.windowMs ?? 60_000,
  });

  const map = new Map<string, Entry>();
  // client identity → its publish groups → the object keys in each. Both Maps
  // are held in ACCESS order (re-insert on touch), so iteration order is
  // least-recently-used first and `.keys().next()` is the eviction victim.
  const clients = new Map<string, Map<string, Set<string>>>();
  // group → the client identity that budget-owns it, for the group's whole life.
  // Ownership is per GROUP, not per key: charging an overwrite to whoever sent it
  // would split one publish across two budgets (R5).
  const groupOwners = new Map<string, string>();
  let totalBytes = 0;

  function groupsOf(client: string): Map<string, Set<string>> {
    let groups = clients.get(client);
    if (!groups) {
      groups = new Map();
      clients.set(client, groups);
    }
    return groups;
  }

  function entryCount(groups: Map<string, Set<string>>): number {
    let n = 0;
    for (const keys of groups.values()) n += keys.size;
    return n;
  }

  /** Move a client (and one of its groups) to the tail = most recently used. */
  function touch(client: string, group?: string): void {
    const groups = clients.get(client);
    if (!groups) return;
    clients.delete(client);
    clients.set(client, groups);
    if (group === undefined) return;
    const keys = groups.get(group);
    if (!keys) return;
    groups.delete(group);
    groups.set(group, keys);
  }

  function forget(key: string): void {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    totalBytes -= entry.body.byteLength;
    const groups = clients.get(entry.client);
    const keys = groups?.get(entry.group);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) {
      groups!.delete(entry.group);
      groupOwners.delete(entry.group);
    }
    if (groups!.size === 0) clients.delete(entry.client);
  }

  /** Evict a whole publish. Members only mean anything together. */
  function dropGroup(client: string, group: string): number {
    const keys = clients.get(client)?.get(group);
    if (!keys) return 0;
    const dropped = keys.size;
    for (const key of [...keys]) forget(key);
    return dropped;
  }

  /** Evict the least-recently-used group of the least-recently-active client. */
  function dropGlobalLru(protect?: { client: string; group: string }): boolean {
    for (const [client, groups] of clients) {
      for (const group of groups.keys()) {
        if (protect && protect.client === client && protect.group === group) continue;
        return dropGroup(client, group) > 0;
      }
    }
    return false;
  }

  function sweep(): void {
    const t = now();
    for (const [k, e] of map) if (e.expiresAt <= t) forget(k);
  }

  // `clientIp` is the client identity the server layer resolved (client-ip.ts):
  // the socket peer, or the address the trusted proxy hop appended. NEVER a raw
  // X-Forwarded-For — that is spoofable and would let one client mint unlimited
  // rate-limit buckets AND unlimited eviction budgets. Defaults to a single
  // shared bucket if the server layer did not supply one, which fails closed.
  async function handlePut(req: Request, url: URL, clientIp = 'local'): Promise<Response> {
    if (req.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

    const rl = limiter.check(clientIp);
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }

    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    if (!key) return json({ error: 'missing_key' }, 400);

    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > maxObjectBytes) {
      return json({ error: 'too_large', maxObjectBytes }, 413);
    }

    sweep();

    const group = publishGroupOf(key);
    // The write is charged to the GROUP's owner, not to whoever sent it, so a
    // publish revised from a rotated address stays on one budget and evicts
    // whole. A first writer claims the group. Not a new exposure either way: the
    // route is unauthenticated with client-chosen keys, so anyone could already
    // replace anyone's bytes — did:webvh logs are self-certifying and fail
    // verification if they do.
    const owner = groupOwners.get(group) ?? clientIp;

    forget(key);

    // Claim the slot and mark it most-recently-used, so the group being written
    // is only ever its own victim when it is the owner's ONLY group.
    const claim = (): Map<string, Set<string>> => {
      const groups = groupsOf(owner);
      if (!groups.has(group)) groups.set(group, new Set());
      groupOwners.set(group, owner);
      touch(owner, group);
      return groups;
    };

    // Per-writer budget: evict the owner's own LRU groups until the write
    // fits. A single publish larger than the cap ends up as the only group and
    // restarts itself whole — mangling the flooder's own publish, never a
    // neighbour's, and never leaving a half-publish behind.
    let groups = claim();
    while (entryCount(groups) + 1 > perClientCap) {
      const victim = groups.keys().next().value as string | undefined;
      if (victim === undefined) break;
      const dropped = dropGroup(owner, victim);
      groups = claim();
      if (dropped === 0) break;
    }

    groups.get(group)!.add(key);
    map.set(key, {
      body,
      contentType: req.headers.get('content-type') ?? 'application/octet-stream',
      expiresAt: now() + ttlMs,
      client: owner,
      group,
    });
    totalBytes += body.byteLength;
    touch(owner, group);

    // Process-wide ceilings. Reaching these takes many distinct client
    // identities (the per-writer budget stops a single one), and the victim is
    // the least-recently-active client's oldest publish — never the write that
    // just arrived.
    while (map.size > maxEntries || totalBytes > maxTotalBytes) {
      if (!dropGlobalLru({ client: owner, group })) break;
    }
    while (clients.size > maxClients) {
      const victim = clients.keys().next().value;
      if (victim === undefined || victim === owner) break;
      for (const g of [...clients.get(victim)!.keys()]) dropGroup(victim, g);
      clients.delete(victim);
    }

    return json({ ok: true }, 200);
  }

  /** Recency bump on a hit, so an actively resolved publish outlives an idle one. */
  function hit(key: string): Entry | undefined {
    const entry = map.get(key);
    if (entry) touch(entry.client, entry.group);
    return entry;
  }

  // Read by object key — the counterpart to handlePut, for the StorageAdapter's
  // GET /api/host/<key> (adapter.get). Keyed by the decoded object key (same as
  // the put key), NOT the resolver host+pathname form that `serve` uses. Returns
  // 404 JSON on a miss so the adapter maps it to null — and so an EVICTED entry
  // reads as a clean miss rather than an error.
  function read(url: URL): Response {
    sweep();
    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    const entry = hit(key);
    if (!entry) return json({ error: 'not_found' }, 404);
    // Copy so the caller can't mutate stored bytes.
    return new Response(entry.body.slice(), { status: 200, headers: untrustedHeaders(entry.contentType) });
  }

  function serve(_req: Request, url: URL): Response | null {
    sweep();
    const key = `${url.host}${url.pathname}`;
    const entry = hit(key);
    if (!entry) return null;
    // Copy so the caller can't mutate stored bytes.
    return new Response(entry.body.slice(), { status: 200, headers: untrustedHeaders(entry.contentType) });
  }

  return {
    handlePut,
    read,
    serve,
    size: () => map.size,
    /** Capacity telemetry — for tests and any future memory reporting. */
    stats: () => ({ entries: map.size, clients: clients.size, bytes: totalBytes }),
  };
}

// The store is unauthenticated (public demo — must run without secrets), so ALL
// served content is untrusted. Both serve() and read() return stored bytes to a
// browser, so both MUST neutralize stored-XSS: nosniff + a sandbox CSP +
// attachment disposition mean a browser never executes served bytes as a page
// regardless of their content-type. did:webvh resolution is unaffected — it
// reads the log via fetch(), where these headers don't apply.
export function untrustedHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'attachment',
  };
}
