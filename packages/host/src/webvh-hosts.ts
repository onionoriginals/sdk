/**
 * The did:webvh hosts this instance serves (#976 B, G1; P3.6). A did:webvh is
 * fetched from the domain it names, so an instance holds and serves hosted
 * files only under its own domains: the canonical host the SPA mints new DIDs
 * on, and any extra domains earlier identities were minted on (the landing
 * passes its legacy did:webvh domain). A key under any other host would be
 * bytes no reader of that DID fetches here.
 *
 * Undefined when there is no canonical host (dev, tests): then nothing is
 * redirected and any host is accepted, as before.
 */
export function servedWebvhHosts(canonicalHost: string | undefined, extraHosts: readonly string[] = []): readonly string[] | undefined {
  if (!canonicalHost) return undefined;
  return [...new Set([canonicalHost.toLowerCase(), ...extraHosts])];
}
