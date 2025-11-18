import { describe, it, expect } from 'bun:test';
import {
  WEBVH_NETWORKS,
  DEFAULT_WEBVH_NETWORK,
  getNetworkConfig,
  getNetworkDomain,
  getNetworkContextUrl,
  validateVersionForNetwork,
  getRecommendedNetworkForVersion,
  getBitcoinNetworkForWebVH,
  getWebVHNetworkForBitcoin,
  type WebVHNetworkName,
  type BitcoinNetworkName,
} from '../../../src/types/network';

describe('Network Configuration', () => {
  describe('WEBVH_NETWORKS', () => {
    it('should define all three networks', () => {
      expect(WEBVH_NETWORKS.magby).toBeDefined();
      expect(WEBVH_NETWORKS.cleffa).toBeDefined();
      expect(WEBVH_NETWORKS.pichu).toBeDefined();
    });

    it('should have correct domains for each network', () => {
      expect(WEBVH_NETWORKS.magby.domain).toBe('magby.originals.build');
      expect(WEBVH_NETWORKS.cleffa.domain).toBe('cleffa.originals.build');
      expect(WEBVH_NETWORKS.pichu.domain).toBe('pichu.originals.build');
    });

    it('should have correct stability levels', () => {
      expect(WEBVH_NETWORKS.magby.stability).toBe('patch');
      expect(WEBVH_NETWORKS.cleffa.stability).toBe('minor');
      expect(WEBVH_NETWORKS.pichu.stability).toBe('major');
    });

    it('should have correct context URLs', () => {
      expect(WEBVH_NETWORKS.magby.contextUrl).toBe('https://magby.originals.build/context');
      expect(WEBVH_NETWORKS.cleffa.contextUrl).toBe('https://cleffa.originals.build/context');
      expect(WEBVH_NETWORKS.pichu.contextUrl).toBe('https://pichu.originals.build/context');
    });
  });

  describe('DEFAULT_WEBVH_NETWORK', () => {
    it('should default to pichu (production)', () => {
      expect(DEFAULT_WEBVH_NETWORK).toBe('pichu');
    });
  });

  describe('getNetworkConfig', () => {
    it('should return correct config for each network', () => {
      const magbyConfig = getNetworkConfig('magby');
      expect(magbyConfig.name).toBe('magby');
      expect(magbyConfig.domain).toBe('magby.originals.build');

      const cleffaConfig = getNetworkConfig('cleffa');
      expect(cleffaConfig.name).toBe('cleffa');
      expect(cleffaConfig.domain).toBe('cleffa.originals.build');

      const pichuConfig = getNetworkConfig('pichu');
      expect(pichuConfig.name).toBe('pichu');
      expect(pichuConfig.domain).toBe('pichu.originals.build');
    });

    it('should throw error for invalid network', () => {
      expect(() => getNetworkConfig('invalid' as WebVHNetworkName)).toThrow(
        'Invalid WebVH network: invalid'
      );
    });
  });

  describe('getNetworkDomain', () => {
    it('should return correct domain for each network', () => {
      expect(getNetworkDomain('magby')).toBe('magby.originals.build');
      expect(getNetworkDomain('cleffa')).toBe('cleffa.originals.build');
      expect(getNetworkDomain('pichu')).toBe('pichu.originals.build');
    });
  });

  describe('getNetworkContextUrl', () => {
    it('should return correct context URL for each network', () => {
      expect(getNetworkContextUrl('magby')).toBe('https://magby.originals.build/context');
      expect(getNetworkContextUrl('cleffa')).toBe('https://cleffa.originals.build/context');
      expect(getNetworkContextUrl('pichu')).toBe('https://pichu.originals.build/context');
    });
  });

  describe('validateVersionForNetwork', () => {
    describe('pichu (major releases only)', () => {
      it('should accept major releases (X.0.0)', () => {
        expect(validateVersionForNetwork('1.0.0', 'pichu')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'pichu')).toBe(true);
        expect(validateVersionForNetwork('10.0.0', 'pichu')).toBe(true);
      });

      it('should reject minor releases (X.Y.0 where Y > 0)', () => {
        expect(validateVersionForNetwork('1.1.0', 'pichu')).toBe(false);
        expect(validateVersionForNetwork('2.5.0', 'pichu')).toBe(false);
      });

      it('should reject patch releases (X.Y.Z where Z > 0)', () => {
        expect(validateVersionForNetwork('1.0.1', 'pichu')).toBe(false);
        expect(validateVersionForNetwork('1.1.1', 'pichu')).toBe(false);
        expect(validateVersionForNetwork('2.3.4', 'pichu')).toBe(false);
      });
    });

    describe('cleffa (minor releases)', () => {
      it('should accept major releases (X.0.0)', () => {
        expect(validateVersionForNetwork('1.0.0', 'cleffa')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'cleffa')).toBe(true);
      });

      it('should accept minor releases (X.Y.0)', () => {
        expect(validateVersionForNetwork('1.1.0', 'cleffa')).toBe(true);
        expect(validateVersionForNetwork('2.5.0', 'cleffa')).toBe(true);
        expect(validateVersionForNetwork('10.20.0', 'cleffa')).toBe(true);
      });

      it('should reject patch releases (X.Y.Z where Z > 0)', () => {
        expect(validateVersionForNetwork('1.0.1', 'cleffa')).toBe(false);
        expect(validateVersionForNetwork('1.1.1', 'cleffa')).toBe(false);
        expect(validateVersionForNetwork('2.3.4', 'cleffa')).toBe(false);
      });
    });

    describe('magby (all versions)', () => {
      it('should accept major releases', () => {
        expect(validateVersionForNetwork('1.0.0', 'magby')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'magby')).toBe(true);
      });

      it('should accept minor releases', () => {
        expect(validateVersionForNetwork('1.1.0', 'magby')).toBe(true);
        expect(validateVersionForNetwork('2.5.0', 'magby')).toBe(true);
      });

      it('should accept patch releases', () => {
        expect(validateVersionForNetwork('1.0.1', 'magby')).toBe(true);
        expect(validateVersionForNetwork('1.1.1', 'magby')).toBe(true);
        expect(validateVersionForNetwork('2.3.4', 'magby')).toBe(true);
      });
    });

    it('should handle pre-release versions', () => {
      // Pre-release should still follow the same rules for the base version
      expect(validateVersionForNetwork('1.0.0-beta.1', 'pichu')).toBe(true);
      expect(validateVersionForNetwork('1.1.0-alpha', 'pichu')).toBe(false);
      expect(validateVersionForNetwork('1.1.0-beta.1', 'cleffa')).toBe(true);
      expect(validateVersionForNetwork('1.1.1-rc.1', 'cleffa')).toBe(false);
    });

    it('should throw error for invalid version format', () => {
      expect(() => validateVersionForNetwork('invalid', 'pichu')).toThrow('Invalid version format');
      expect(() => validateVersionForNetwork('1.0', 'pichu')).toThrow('Invalid version format');
      expect(() => validateVersionForNetwork('v1.0.0', 'pichu')).toThrow('Invalid version format');
    });
  });

  describe('getRecommendedNetworkForVersion', () => {
    it('should recommend pichu for major releases', () => {
      expect(getRecommendedNetworkForVersion('1.0.0')).toBe('pichu');
      expect(getRecommendedNetworkForVersion('2.0.0')).toBe('pichu');
      expect(getRecommendedNetworkForVersion('10.0.0')).toBe('pichu');
    });

    it('should recommend cleffa for minor releases', () => {
      expect(getRecommendedNetworkForVersion('1.1.0')).toBe('cleffa');
      expect(getRecommendedNetworkForVersion('2.5.0')).toBe('cleffa');
      expect(getRecommendedNetworkForVersion('10.20.0')).toBe('cleffa');
    });

    it('should recommend magby for patch releases', () => {
      expect(getRecommendedNetworkForVersion('1.0.1')).toBe('magby');
      expect(getRecommendedNetworkForVersion('1.1.1')).toBe('magby');
      expect(getRecommendedNetworkForVersion('2.3.4')).toBe('magby');
    });

    it('should handle pre-release versions correctly', () => {
      expect(getRecommendedNetworkForVersion('1.0.0-beta')).toBe('pichu');
      expect(getRecommendedNetworkForVersion('1.1.0-alpha')).toBe('cleffa');
      expect(getRecommendedNetworkForVersion('1.1.1-rc.1')).toBe('magby');
    });
  });

  describe('Bitcoin Network Mapping', () => {
    describe('WEBVH_NETWORKS Bitcoin mappings', () => {
      it('should map magby to regtest', () => {
        expect(WEBVH_NETWORKS.magby.bitcoinNetwork).toBe('regtest');
      });

      it('should map cleffa to signet', () => {
        expect(WEBVH_NETWORKS.cleffa.bitcoinNetwork).toBe('signet');
      });

      it('should map pichu to mainnet', () => {
        expect(WEBVH_NETWORKS.pichu.bitcoinNetwork).toBe('mainnet');
      });
    });

    describe('getBitcoinNetworkForWebVH', () => {
      it('should return regtest for magby', () => {
        expect(getBitcoinNetworkForWebVH('magby')).toBe('regtest');
      });

      it('should return signet for cleffa', () => {
        expect(getBitcoinNetworkForWebVH('cleffa')).toBe('signet');
      });

      it('should return mainnet for pichu', () => {
        expect(getBitcoinNetworkForWebVH('pichu')).toBe('mainnet');
      });
    });

    describe('getWebVHNetworkForBitcoin', () => {
      it('should return magby for regtest', () => {
        expect(getWebVHNetworkForBitcoin('regtest')).toBe('magby');
      });

      it('should return cleffa for signet', () => {
        expect(getWebVHNetworkForBitcoin('signet')).toBe('cleffa');
      });

      it('should return pichu for mainnet', () => {
        expect(getWebVHNetworkForBitcoin('mainnet')).toBe('pichu');
      });

      it('should return undefined for testnet (no direct mapping)', () => {
        expect(getWebVHNetworkForBitcoin('testnet')).toBeUndefined();
      });
    });

    describe('Network mapping consistency', () => {
      it('should have bidirectional mapping for all WebVH networks', () => {
        // magby ↔ regtest
        const magbyBitcoin = getBitcoinNetworkForWebVH('magby');
        expect(getWebVHNetworkForBitcoin(magbyBitcoin)).toBe('magby');

        // cleffa ↔ signet
        const cleffaBitcoin = getBitcoinNetworkForWebVH('cleffa');
        expect(getWebVHNetworkForBitcoin(cleffaBitcoin)).toBe('cleffa');

        // pichu ↔ mainnet
        const pichuBitcoin = getBitcoinNetworkForWebVH('pichu');
        expect(getWebVHNetworkForBitcoin(pichuBitcoin)).toBe('pichu');
      });

      it('should maintain environment consistency across networks', () => {
        // Development: magby → regtest
        expect(getBitcoinNetworkForWebVH('magby')).toBe('regtest');

        // Staging: cleffa → signet
        expect(getBitcoinNetworkForWebVH('cleffa')).toBe('signet');

        // Production: pichu → mainnet
        expect(getBitcoinNetworkForWebVH('pichu')).toBe('mainnet');
      });
    });
  });
});
