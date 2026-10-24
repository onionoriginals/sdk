/**
 * Product features that are not open yet. The Originals Protocol replaced
 * CEL 3 (plan 011, PR 5): creating and editing Originals, and downloading their
 * evidence, work now. Hosted publication (a did:webvh alias; plan 011, PR 8) is
 * built and stays off until the owner's public-host proof passes (owner
 * decision Q13). Bitcoin anchoring (plan 011, PR 10b) is built and stays off
 * until the owner's release gate (#975). Tests override these through
 * DemoEngine's options.
 *
 * Anchoring has one build switch, for the disposable regtest journey and the
 * owner's acceptance runs: VITE_ORIGINALS_BITCOIN_ANCHORING=1 at build time.
 * The server has its own (ORIGINALS_BITCOIN_ANCHORING); server/config.ts
 * reports the two disagreeing, and reports a deployment that sets them.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const FEATURES = Object.freeze({
  /** Publish an Original to the web under a did:webvh alias (no witnesses, owner decision Q14). */
  hostedPublication: false,
  /** Anchor an Original on a Bitcoin sat (did:btco). Off unless built with VITE_ORIGINALS_BITCOIN_ANCHORING=1. */
  bitcoinAnchoring: env.VITE_ORIGINALS_BITCOIN_ANCHORING === '1',
  /** Browse and verify other people's published Originals. */
  explore: false,
});

export type Feature = keyof typeof FEATURES;

export function featureEnabled(feature: Feature): boolean {
  return FEATURES[feature];
}
