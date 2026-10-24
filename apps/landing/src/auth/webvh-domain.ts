/**
 * The did:webvh domain this build publishes under (#976 B, gap G1). A
 * did:webvh names the host its log is fetched from, and that domain can never
 * change after publication, so it is the host the SPA was built for:
 * `VITE_WEBVH_HOST`, baked by Vite. Readers fetch what was published there
 * (P3.6), and the server serves the hosted layout under that host.
 *
 * Unset, the legacy domain is kept so a dev build mints what it always did
 * (PROVISIONAL). Identities already minted on the legacy domain stay their
 * author's identity (see `readUserWebVHDid`).
 */
export const LEGACY_WEBVH_DOMAIN = 'magby.originals.build';

// The same rule as server/config.ts `isBareHost`: no scheme, port or path; lowercase; dotted.
const BARE_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

type Env = Record<string, string | undefined>;

function buildEnv(): Env {
  return (import.meta as unknown as { env?: Env }).env ?? {};
}

/** The build's did:webvh domain. A malformed `VITE_WEBVH_HOST` throws rather than mint a DID on it. */
export function webvhDomain(env: Env = buildEnv()): string {
  const host = env.VITE_WEBVH_HOST;
  if (!host) return LEGACY_WEBVH_DOMAIN;
  if (!BARE_HOST.test(host)) {
    throw new Error(`VITE_WEBVH_HOST="${host}" is not a bare lowercase hostname; no did:webvh is minted on it.`);
  }
  return host;
}
