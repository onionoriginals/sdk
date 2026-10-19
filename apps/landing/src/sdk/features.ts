/**
 * Product features that wait on later phases of plan 011. The Originals
 * Protocol replaced CEL 3 (plan 011, PR 5): creating and editing Originals,
 * and downloading their evidence, work now. Hosted publication with witnesses
 * and the did:webvh alias returns with PR 8, and Bitcoin anchoring with PR 10.
 * Until then these stay off. They are constants, not environment switches,
 * because the code paths they would enable do not exist yet.
 */
export const FEATURES = Object.freeze({
  /** Publish an Original to the web (did:webvh alias, witnesses). */
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
