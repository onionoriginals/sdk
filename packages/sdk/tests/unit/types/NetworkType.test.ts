import { describe, test, expect } from 'bun:test';
import type { BitcoinNetworkName } from '../../../src/types/network';
import type { OriginalsConfig } from '../../../src/types/common';
import type { BitcoinAnchoringContext } from '../../../src/migration/types';

/**
 * Contract tests ensuring network type consistency across all config structs.
 * Prevents regression where different modules use incompatible network literals.
 */
describe('Network type consistency', () => {
  test('BitcoinNetworkName accepts all valid SDK network values', () => {
    const networks: BitcoinNetworkName[] = ['mainnet', 'regtest', 'signet'];
    expect(networks).toHaveLength(3);
  });

  test('OriginalsConfig.network uses BitcoinNetworkName', () => {
    // Type-level assertion: if this compiles, the types are compatible
    const config: Pick<OriginalsConfig, 'network'> = { network: 'mainnet' };
    expect(config.network).toBe('mainnet');

    const config2: Pick<OriginalsConfig, 'network'> = { network: 'regtest' };
    expect(config2.network).toBe('regtest');

    const config3: Pick<OriginalsConfig, 'network'> = { network: 'signet' };
    expect(config3.network).toBe('signet');
  });

  test('BitcoinAnchoringContext.network uses BitcoinNetworkName', () => {
    // Type-level assertion: if this compiles, the types are compatible
    const ctx: Pick<BitcoinAnchoringContext, 'network'> = { network: 'mainnet' };
    expect(ctx.network).toBe('mainnet');

    const ctx2: Pick<BitcoinAnchoringContext, 'network'> = { network: 'regtest' };
    expect(ctx2.network).toBe('regtest');

    const ctx3: Pick<BitcoinAnchoringContext, 'network'> = { network: 'signet' };
    expect(ctx3.network).toBe('signet');
  });

  test('OriginalsConfig and BitcoinAnchoringContext network types are assignable', () => {
    // Verifies both types accept the same values — no drift possible
    const configNetwork: OriginalsConfig['network'] = 'regtest';
    const anchoringNetwork: BitcoinAnchoringContext['network'] = configNetwork;
    expect(anchoringNetwork).toBe('regtest');
  });
});
