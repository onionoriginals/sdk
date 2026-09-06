/**
 * Bitcoin network enablement flag — a standalone, dependency-free module so
 * components (e.g. Demo.tsx) can read it WITHOUT statically importing the
 * heavy engine module, which would defeat the engine chunk's lazy-loading.
 *
 * `VITE_BTC_NETWORK` selects the deploy's Bitcoin surface:
 *   - 'mainnet'  — real inscriptions, creator-pays deposits (no faucet)
 *   - 'testnet4' — real inscriptions on testnet4, faucet-funded (worthless tBTC)
 *   - 'off' / unset — the self-contained OrdMockProvider mock
 *
 * The legacy `VITE_BTC_TESTNET=1` flag is honored as an alias for 'testnet4'
 * so existing deploys don't silently fall back to mock on upgrade.
 */
export type BtcNetworkFlag = 'mainnet' | 'testnet4' | 'off';

export function btcNetwork(): BtcNetworkFlag {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  const v = env.VITE_BTC_NETWORK;
  if (v === 'mainnet' || v === 'testnet4') return v;
  if (v === undefined || v === '' ) {
    return env.VITE_BTC_TESTNET === '1' ? 'testnet4' : 'off';
  }
  return 'off';
}

/** True when real Bitcoin signing/broadcast is enabled (testnet4 OR mainnet). */
export function btcRealEnabled(): boolean {
  return btcNetwork() !== 'off';
}

/**
 * May the `?smoke=1` auto-run harness execute on this build (R12)? It runs
 * unauthenticated on load and drives the full create→publish→inscribe path, so
 * on a real-network build it would hit the real provider from an anonymous
 * page load. The money routes are JWT-gated so it cannot move funds, but the
 * resulting console errors breach the CI floor — and an unauthenticated route
 * has no business on the real-network path at all. Mock builds only.
 */
export function smokeAutoRunAllowed(flag: BtcNetworkFlag = btcNetwork()): boolean {
  return flag === 'off';
}

// The block explorer link for a real inscription's reveal txid, on whichever
// network the deploy enabled. A mock/regtest txid has no public explorer.
// Lives here (not engine.ts) so light page chunks can link explorers without
// pulling in the heavy engine module.
export function btcoExplorerUrl(txid: string): string | undefined {
  const net = btcNetwork();
  if (net === 'off' || !txid) return undefined;
  return net === 'mainnet'
    ? `https://mempool.space/tx/${txid}`
    : `https://mempool.space/testnet4/tx/${txid}`;
}

/** The Bitcoin network handed to `OriginalsSDK.create`. */
export type SdkNetwork = 'mainnet' | 'testnet' | 'regtest';
/** The webvh deployment tier matching that network (magby↔regtest, cleffa↔signet/testnet, pichu↔mainnet). */
export type WebvhTier = 'magby' | 'cleffa' | 'pichu';

export interface DemoTier {
  /** True when THIS visitor gets real Bitcoin: the deploy enables it AND they are signed in. */
  real: boolean;
  network: SdkNetwork;
  webvhNetwork: WebvhTier;
}

/**
 * The one derived value for "which tier is this visitor in" (R5). Both the
 * engine's ordinals-provider choice and the UI's step-3 presentation read it,
 * so an enabled money button and a "simulation" label can never disagree.
 *
 * Real Bitcoin needs BOTH: a deploy that enables it and a signed-in visitor
 * with a key to sign with. An anonymous visitor keeps the mock on every
 * network — the flag alone used to hand them an enabled button that errored.
 *
 * The webvh tier follows the resolved network, not the build flag: an
 * anonymous engine on a mainnet deploy is a regtest/mock engine, and a tier
 * that disagreed with its network is exactly what the SDK warns about. The
 * tier does not reach the DID string — the demo passes its host explicitly.
 */
export function demoTier(flag: BtcNetworkFlag, authed: boolean): DemoTier {
  const real = flag !== 'off' && authed;
  const network: SdkNetwork = !real ? 'regtest' : flag === 'mainnet' ? 'mainnet' : 'testnet';
  const webvhNetwork: WebvhTier =
    network === 'mainnet' ? 'pichu' : network === 'testnet' ? 'cleffa' : 'magby';
  return { real, network, webvhNetwork };
}

/**
 * Whether THIS visitor gets the real Bitcoin path. `btcRealEnabled()` answers
 * the deploy-level question ("is real Bitcoin turned on here at all"); this
 * answers the visitor-level one, which is what the UI must gate on.
 */
export function btcRealFor(authed: boolean): boolean {
  return demoTier(btcNetwork(), authed).real;
}
