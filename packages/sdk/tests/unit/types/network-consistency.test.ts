/**
 * Network type consistency tests
 *
 * Ensures that BitcoinNetworkName is the single canonical network type
 * used consistently across all config structs and modules.
 */
import { describe, test, expect } from 'bun:test';
import type { BitcoinNetworkName } from '../../../src/types/network';
import { WEBVH_NETWORKS, getBitcoinNetworkForWebVH, getWebVHNetworkForBitcoin } from '../../../src/types/network';
import { OriginalsSDK } from '../../../src/core/OriginalsSDK';

const VALID_NETWORKS: BitcoinNetworkName[] = ['mainnet', 'regtest', 'signet'];
const INVALID_NETWORKS = ['testnet', 'devnet', 'localnet', '', 'MAINNET'];

describe('Network type consistency', () => {
  describe('BitcoinNetworkName is the canonical type', () => {
    test('has exactly three valid values', () => {
      expect(VALID_NETWORKS).toEqual(['mainnet', 'regtest', 'signet']);
    });

    test('testnet is not a valid BitcoinNetworkName', () => {
      // 'testnet' was historically used in some modules but is not part
      // of the canonical type. The SDK uses 'regtest' for local development
      // and 'signet' for testing.
      expect(VALID_NETWORKS).not.toContain('testnet');
    });
  });

  describe('OriginalsConfig.network accepts only canonical values', () => {
    test.each(VALID_NETWORKS)('accepts %s', (network) => {
      expect(() =>
        OriginalsSDK.create({ network, defaultKeyType: 'Ed25519' })
      ).not.toThrow();
    });

    test.each(INVALID_NETWORKS)('rejects %s', (network) => {
      expect(() =>
        // @ts-expect-error testing invalid runtime values
        OriginalsSDK.create({ network, defaultKeyType: 'Ed25519' })
      ).toThrow(/Invalid network/);
    });
  });

  describe('WebVH ↔ Bitcoin network mapping is consistent', () => {
    test('every WebVH network maps to a valid BitcoinNetworkName', () => {
      for (const [name, config] of Object.entries(WEBVH_NETWORKS)) {
        expect(VALID_NETWORKS).toContain(config.bitcoinNetwork);
      }
    });

    test('getBitcoinNetworkForWebVH returns valid BitcoinNetworkName', () => {
      expect(getBitcoinNetworkForWebVH('magby')).toBe('regtest');
      expect(getBitcoinNetworkForWebVH('cleffa')).toBe('signet');
      expect(getBitcoinNetworkForWebVH('pichu')).toBe('mainnet');
    });

    test('getWebVHNetworkForBitcoin is inverse of getBitcoinNetworkForWebVH', () => {
      for (const network of VALID_NETWORKS) {
        const webvh = getWebVHNetworkForBitcoin(network);
        expect(webvh).toBeDefined();
        expect(getBitcoinNetworkForWebVH(webvh!)).toBe(network);
      }
    });

    test('magby maps to regtest (not testnet)', () => {
      expect(WEBVH_NETWORKS.magby.bitcoinNetwork).toBe('regtest');
    });

    test('cleffa maps to signet (not testnet)', () => {
      expect(WEBVH_NETWORKS.cleffa.bitcoinNetwork).toBe('signet');
    });
  });

  describe('network literals are exhaustive', () => {
    test('all three canonical networks have a WebVH mapping', () => {
      const mappedNetworks = Object.values(WEBVH_NETWORKS).map(c => c.bitcoinNetwork);
      for (const network of VALID_NETWORKS) {
        expect(mappedNetworks).toContain(network);
      }
    });
  });
});
