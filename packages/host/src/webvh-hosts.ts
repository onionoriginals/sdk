/**
 * The did:webvh hosts this instance serves (#976 B, G1; P3.6). A did:webvh is
 * fetched from the domain it names, so an instance holds and serves hosted
 * files only under its own domains: the canonical host the SPA mints new DIDs
 * on, and the legacy domain earlier identities were minted on. A key under any
 * other host would be bytes no reader of that DID fetches here.
 *
 * Undefined when there is no canonical host (dev, tests): then nothing is
 * redirected and any host is accepted, as before.
 */
import { LEGACY_WEBVH_DOMAIN } from '../src/auth/webvh-domain';

export function servedWebvhHosts(canonicalHost: string | undefined): readonly string[] | undefined {
  if (!canonicalHost) return undefined;
  return [...new Set([canonicalHost.toLowerCase(), LEGACY_WEBVH_DOMAIN])];
}
