import { describe, test, expect } from 'bun:test';
import { btcNetwork, btcRealEnabled, btcRealFor, demoTier, smokeAutoRunAllowed } from './network-flag';

// import.meta.env is not writable per-test under bun, so these tests assert
// the UNSET default (this test env sets neither VITE_BTC_NETWORK nor the
// legacy VITE_BTC_TESTNET): the flag must resolve to 'off' / mock.
describe('network flag', () => {
  test('defaults to off (mock) when no env is set', () => {
    expect(btcNetwork()).toBe('off');
    expect(btcRealEnabled()).toBe(false);
  });
});

/**
 * U2 / R5 — the real Bitcoin path is decided by AUTH combined with the build
 * flag, never by the flag alone. `demoTier` is the single derived value the
 * engine's provider choice and the UI's step-3 presentation both read, so
 * they cannot disagree. The flag is passed in (import.meta.env is not
 * writable per-test) which is also how the engine takes its test override.
 */
describe('demoTier', () => {
  test('an anonymous visitor stays simulated on a mainnet build', () => {
    const tier = demoTier('mainnet', false);
    expect(tier.real).toBe(false);
    expect(tier.network).toBe('regtest');
    expect(tier.webvhNetwork).toBe('magby');
  });

  test('a signed-in visitor on a mainnet build gets the real tier', () => {
    expect(demoTier('mainnet', true)).toEqual({
      real: true,
      network: 'mainnet',
      webvhNetwork: 'pichu'
    });
  });

  test('testnet4 maps to the SDK testnet network and the staging webvh tier', () => {
    expect(demoTier('testnet4', true)).toEqual({
      real: true,
      network: 'testnet',
      webvhNetwork: 'cleffa'
    });
    expect(demoTier('testnet4', false).real).toBe(false);
  });

  test('with the flag off, auth changes nothing — both tiers are the mock', () => {
    expect(demoTier('off', true)).toEqual(demoTier('off', false));
    expect(demoTier('off', true)).toEqual({
      real: false,
      network: 'regtest',
      webvhNetwork: 'magby'
    });
  });

  test('the webvh tier always matches the network handed to the SDK', () => {
    const pairs: Record<string, string> = { mainnet: 'pichu', testnet: 'cleffa', regtest: 'magby' };
    for (const flag of ['mainnet', 'testnet4', 'off'] as const) {
      for (const authed of [true, false]) {
        const tier = demoTier(flag, authed);
        expect(tier.webvhNetwork).toBe(pairs[tier.network] as never);
      }
    }
  });
});

describe('btcRealFor', () => {
  // This test env sets no VITE_BTC_NETWORK, so the deploy flag is 'off'.
  test('nobody gets the real path on a mock deploy', () => {
    expect(btcRealFor(true)).toBe(false);
    expect(btcRealFor(false)).toBe(false);
  });
});

/**
 * U6 / R12 — `?smoke=1` runs unauthenticated on load and drives the full
 * lifecycle. On a real-network build that means the real provider path from an
 * anonymous page load, so the auto-run is mock-build only.
 */
describe('smokeAutoRunAllowed', () => {
  test('the auto-run is refused on any real-network build', () => {
    expect(smokeAutoRunAllowed('mainnet')).toBe(false);
    expect(smokeAutoRunAllowed('testnet4')).toBe(false);
  });

  test('a mock build still runs it — the existing smoke harness is preserved', () => {
    expect(smokeAutoRunAllowed('off')).toBe(true);
    // This test env sets no VITE_BTC_NETWORK, so the default read is the mock.
    expect(smokeAutoRunAllowed()).toBe(true);
  });
});
