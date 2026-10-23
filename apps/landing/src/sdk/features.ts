/**
 * Product features that are not open yet. The Originals Protocol replaced
 * CEL 3 (plan 011, PR 5): creating and editing Originals, and downloading their
 * evidence, work now. Hosted publication (a did:webvh alias; plan 011, PR 8) is
 * built and stays off until the owner's public-host proof passes (owner
 * decision Q13). Bitcoin anchoring returns with PR 10. These are constants, not
 * environment switches; tests override them through DemoEngine's options.
 */
export const FEATURES = Object.freeze({
  /** Publish an Original to the web under a did:webvh alias (no witnesses, owner decision Q14). */
  hostedPublication: false,
  /** Anchor an Original on a Bitcoin sat (did:btco). */
  bitcoinAnchoring: false,
  /** Browse and verify other people's published Originals. */
  explore: false,
});

export type Feature = keyof typeof FEATURES;

export function featureEnabled(feature: Feature): boolean {
  return FEATURES[feature];
}
