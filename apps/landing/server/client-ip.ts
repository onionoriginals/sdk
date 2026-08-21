/**
 * THE client-identity policy for rate limiting (R13, KTD7).
 *
 * Every rate-limited route keys on the value this module returns, and nothing
 * else. Two failure modes it exists to close:
 *
 *   - Reading `x-forwarded-for` raw. Proxies APPEND, so the leftmost entry is
 *     whatever the client typed. `split(',')[0]` reads exactly that, and one
 *     client can mint unlimited buckets by rotating it.
 *   - Reading only the socket peer. Behind a proxy that is the PROXY's address,
 *     so every visitor on earth collapses into one bucket.
 *
 * The policy is a trusted-hop COUNT, not a proxy identity: Railway publishes no
 * stable edge address to match against, and the two obvious substitutes (trust
 * any header, or guess a CIDR) both reproduce the bypass. With N trusted
 * proxies in front, the rightmost N entries of the chain were appended by
 * those proxies and the Nth-from-right is the address the outermost trusted
 * proxy actually saw. Everything left of it is unverified client input.
 *
 *   client → proxy1 → server,  N=1:  "<anything the client typed>, <client>"
 *                                                                   ^ taken
 *
 * N comes from TRUSTED_PROXY_HOPS. It defaults to 0 — trust NOTHING — because
 * an unset value on a direct-to-internet deploy would otherwise honour a header
 * no proxy wrote, which is strictly worse than the collapse it would avoid.
 * `config.ts` reports the unset variable as a deployed-environment error, so
 * the degraded case is loud rather than silent. Railway is N=1; verify against
 * the live proxy with the one-line sample app.ts logs on first request.
 */

/** Just the slice of Bun's Server we use: the real peer IP of the connection. */
export interface SocketPeerSource {
  requestIP?(req: Request): { address: string } | null;
}

/** No proxy trusted. See the module header for why this, and not 1. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/**
 * How many proxies sit in front of this process. A missing or malformed value
 * degrades to 0 (ignore the header) — never to "trust it". `config.ts` reports
 * both cases so an operator sees the degrade instead of inheriting it.
 */
export function trustedProxyHops(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TRUSTED_PROXY_HOPS;
  return Number(raw);
}

/**
 * The one client identity every rate limit keys on.
 *
 * Falls back to the socket peer whenever the header cannot be trusted — absent,
 * empty, or shorter than the configured hop count (the trusted proxies did not
 * append what this deploy claims they do, so nothing in it is evidence).
 */
export function resolveClientIp(
  req: Request,
  server?: SocketPeerSource,
  opts: { hops?: number; env?: Record<string, string | undefined> } = {}
): string {
  const peer = server?.requestIP?.(req)?.address || 'local';
  const hops = opts.hops ?? trustedProxyHops(opts.env);
  if (hops <= 0) return peer;
  const chain = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length < hops) return peer;
  return chain[chain.length - hops];
}

/**
 * One line, once per process, so the chosen hop count can be checked against
 * the real proxy without shipping a debug endpoint: compare the logged chain
 * length to TRUSTED_PROXY_HOPS and the resolved value to a known client IP.
 */
export function formatProxySample(
  req: Request,
  resolved: string,
  hops: number
): string {
  const raw = req.headers.get('x-forwarded-for');
  return `[landing] proxy sample: TRUSTED_PROXY_HOPS=${hops} x-forwarded-for=${
    raw === null ? '(absent)' : JSON.stringify(raw)
  } → client identity ${resolved}`;
}
