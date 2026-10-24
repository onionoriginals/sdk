/**
 * Product features that are not open yet. The Originals Protocol replaced
 * CEL 3 (plan 011, PR 5): creating and editing Originals, and downloading their
 * evidence, work now. Each closed feature has its own build-time switch, and
 * nothing else turns it on. Tests override these through DemoEngine's options.
 *
 * - Hosted publication (a did:webvh alias; plan 011, PR 8) is built and stays
 *   off until the owner's public-host proof passes (owner decision Q13). Its
 *   switch exists only for that proof (#976 B, gap G7): a build with
 *   `VITE_ACCEPTANCE_HOSTED_PUBLICATION=1`, a `VITE_WEBVH_HOST` other than the
 *   production host, and a `VITE_BTC_NETWORK` other than `mainnet` turns it
 *   on, so the staging acceptance run can publish through the deployed
 *   routes. The server reports the switch set on a mainnet or production-host
 *   instance (`server/config.ts`). Opening the feature for everyone is a
 *   separate change that cites a passing section B receipt
 *   (`scripts/acceptance/hosted-README.md`).
 * - Bitcoin anchoring is built and stays off until the owner's release gate
 *   (#975), except in builds that set `VITE_ORIGINALS_BITCOIN_ANCHORING=1`.
 *   The server has its own switch, `ORIGINALS_BITCOIN_ANCHORING`, and
 *   `server/config.ts` reports the client and server switches disagreeing.
 */
export interface Features {
  /** Publish an Original to the web under a did:webvh alias (no witnesses, owner decision Q14). */
  readonly hostedPublication: boolean;
  /** Anchor an Original on a Bitcoin sat (did:btco). */
  readonly bitcoinAnchoring: boolean;
  /** Browse and verify other people's published Originals. */
  readonly explore: boolean;
}

/** The host whose builds never take the acceptance switch (nor do mainnet builds). */
export const PRODUCTION_WEBVH_HOST = 'originals.build';

type Env = Record<string, string | undefined>;

/** A staging acceptance build (#976 B, G7): the switch set, not the production host, not mainnet. */
export function acceptanceBuild(env: Env): boolean {
  const host = env.VITE_WEBVH_HOST;
  return env.VITE_ACCEPTANCE_HOSTED_PUBLICATION === '1' && !!host && host !== PRODUCTION_WEBVH_HOST && env.VITE_BTC_NETWORK !== 'mainnet';
}

export function resolveFeatures(env: Env): Features {
  const acceptance = acceptanceBuild(env);
  return Object.freeze({ hostedPublication: acceptance, bitcoinAnchoring: env.VITE_ORIGINALS_BITCOIN_ANCHORING === '1', explore: false });
}

export const FEATURES: Features = resolveFeatures((import.meta as unknown as { env?: Env }).env ?? {});

export type Feature = keyof Features;

export function featureEnabled(feature: Feature): boolean {
  return FEATURES[feature];
}
