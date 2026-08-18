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
