/**
 * Product features that are not open yet. The Originals Protocol replaced
 * CEL 3 (plan 011, PR 5): creating and editing Originals, and downloading their
 * evidence, work now. Hosted publication (a did:webvh alias; plan 011, PR 8) is
 * built and stays off until the owner's public-host proof passes (owner
 * decision Q13). Bitcoin anchoring is built and stays off until
 * the owner’s release gate (#975), except builds explicitly setting
 * VITE_ORIGINALS_BITCOIN_ANCHORING=1. Tests override these through DemoEngine’s options.
 *
 * The one build-time switch is for that proof (#976 B, gap G7): a staging
 * build with `VITE_ACCEPTANCE_HOSTED_PUBLICATION=1` and a `VITE_WEBVH_HOST`
 * other than the production host turns hosted publication on, so the
 * acceptance run can publish through the deployed routes. It is ignored on
 * the production host, and it turns nothing else on. Opening the feature for
 * everyone is a separate change that cites a passing section B receipt
 * (`scripts/acceptance/hosted-README.md`).
 */
export interface Features {
  /** Publish an Original to the web under a did:webvh alias (no witnesses, owner decision Q14). */
  readonly hostedPublication: boolean;
  /** Anchor an Original on a Bitcoin sat (did:btco). */
  readonly bitcoinAnchoring: boolean;
  /** Browse and verify other people's published Originals. */
  readonly explore: boolean;
}

/** The host whose builds never take the acceptance switch. */
export const PRODUCTION_WEBVH_HOST = 'originals.build';

type Env = Record<string, string | undefined>;

export function resolveFeatures(env: Env): Features {
  const host = env.VITE_WEBVH_HOST;
  const acceptance = env.VITE_ACCEPTANCE_HOSTED_PUBLICATION === '1' && !!host && host !== PRODUCTION_WEBVH_HOST;
  return Object.freeze({ hostedPublication: acceptance, bitcoinAnchoring: env.VITE_ORIGINALS_BITCOIN_ANCHORING === '1', explore: false });
}

export const FEATURES: Features = resolveFeatures((import.meta as unknown as { env?: Env }).env ?? {});

export type Feature = keyof Features;

export function featureEnabled(feature: Feature): boolean {
  return FEATURES[feature];
}
