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
      expect(WEBVH_NETWORKS.development).toBeDefined();
      expect(WEBVH_NETWORKS.staging).toBeDefined();
      expect(WEBVH_NETWORKS.production).toBeDefined();
    });

    it('should have correct domains for each network', () => {
      expect(WEBVH_NETWORKS.development.domain).toBe('originals.build');
      expect(WEBVH_NETWORKS.staging.domain).toBe('originals.build');
      expect(WEBVH_NETWORKS.production.domain).toBe('originals.build');
    });

    it('should have correct stability levels', () => {
      expect(WEBVH_NETWORKS.development.stability).toBe('patch');
      expect(WEBVH_NETWORKS.staging.stability).toBe('minor');
      expect(WEBVH_NETWORKS.production.stability).toBe('major');
    });

    it('should have correct context URLs', () => {
      expect(WEBVH_NETWORKS.development.contextUrl).toBe('https://originals.build/context');
      expect(WEBVH_NETWORKS.staging.contextUrl).toBe('https://originals.build/context');
      expect(WEBVH_NETWORKS.production.contextUrl).toBe('https://originals.build/context');
    });
  });

  describe('DEFAULT_WEBVH_NETWORK', () => {
    it('should default to production (production)', () => {
      expect(DEFAULT_WEBVH_NETWORK).toBe('production');
    });
  });

  describe('getNetworkConfig', () => {
    it('should return correct config for each network', () => {
      const developmentConfig = getNetworkConfig('development');
      expect(developmentConfig.name).toBe('development');
      expect(developmentConfig.domain).toBe('originals.build');

      const stagingConfig = getNetworkConfig('staging');
      expect(stagingConfig.name).toBe('staging');
      expect(stagingConfig.domain).toBe('originals.build');

      const productionConfig = getNetworkConfig('production');
      expect(productionConfig.name).toBe('production');
      expect(productionConfig.domain).toBe('originals.build');
    });

    it('should throw error for invalid network', () => {
      expect(() => getNetworkConfig('invalid' as WebVHNetworkName)).toThrow(
        'Invalid WebVH network: invalid'
      );
    });
  });

  describe('getNetworkDomain', () => {
    it('should return correct domain for each network', () => {
      expect(getNetworkDomain('development')).toBe('originals.build');
      expect(getNetworkDomain('staging')).toBe('originals.build');
      expect(getNetworkDomain('production')).toBe('originals.build');
    });
  });

  describe('getNetworkContextUrl', () => {
    it('should return correct context URL for each network', () => {
      expect(getNetworkContextUrl('development')).toBe('https://originals.build/context');
      expect(getNetworkContextUrl('staging')).toBe('https://originals.build/context');
      expect(getNetworkContextUrl('production')).toBe('https://originals.build/context');
    });
  });

  describe('validateVersionForNetwork', () => {
    describe('production (major releases only)', () => {
      it('should accept major releases (X.0.0)', () => {
        expect(validateVersionForNetwork('1.0.0', 'production')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'production')).toBe(true);
        expect(validateVersionForNetwork('10.0.0', 'production')).toBe(true);
      });

      it('should reject minor releases (X.Y.0 where Y > 0)', () => {
        expect(validateVersionForNetwork('1.1.0', 'production')).toBe(false);
        expect(validateVersionForNetwork('2.5.0', 'production')).toBe(false);
      });

      it('should reject patch releases (X.Y.Z where Z > 0)', () => {
        expect(validateVersionForNetwork('1.0.1', 'production')).toBe(false);
        expect(validateVersionForNetwork('1.1.1', 'production')).toBe(false);
        expect(validateVersionForNetwork('2.3.4', 'production')).toBe(false);
      });
    });

    describe('staging (minor releases)', () => {
      it('should accept major releases (X.0.0)', () => {
        expect(validateVersionForNetwork('1.0.0', 'staging')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'staging')).toBe(true);
      });

      it('should accept minor releases (X.Y.0)', () => {
        expect(validateVersionForNetwork('1.1.0', 'staging')).toBe(true);
        expect(validateVersionForNetwork('2.5.0', 'staging')).toBe(true);
        expect(validateVersionForNetwork('10.20.0', 'staging')).toBe(true);
      });

      it('should reject patch releases (X.Y.Z where Z > 0)', () => {
        expect(validateVersionForNetwork('1.0.1', 'staging')).toBe(false);
        expect(validateVersionForNetwork('1.1.1', 'staging')).toBe(false);
        expect(validateVersionForNetwork('2.3.4', 'staging')).toBe(false);
      });
    });

    describe('development (all versions)', () => {
      it('should accept major releases', () => {
        expect(validateVersionForNetwork('1.0.0', 'development')).toBe(true);
        expect(validateVersionForNetwork('2.0.0', 'development')).toBe(true);
      });

      it('should accept minor releases', () => {
        expect(validateVersionForNetwork('1.1.0', 'development')).toBe(true);
        expect(validateVersionForNetwork('2.5.0', 'development')).toBe(true);
      });

      it('should accept patch releases', () => {
        expect(validateVersionForNetwork('1.0.1', 'development')).toBe(true);
        expect(validateVersionForNetwork('1.1.1', 'development')).toBe(true);
        expect(validateVersionForNetwork('2.3.4', 'development')).toBe(true);
      });
    });

    it('should handle pre-release versions', () => {
      // A prerelease is NOT a release (issue #352): only development (all versions)
      // accepts prerelease builds, regardless of the numeric part.
      expect(validateVersionForNetwork('1.0.0-beta.1', 'production')).toBe(false);
      expect(validateVersionForNetwork('1.1.0-alpha', 'production')).toBe(false);
      expect(validateVersionForNetwork('1.1.0-beta.1', 'staging')).toBe(false);
      expect(validateVersionForNetwork('1.1.1-rc.1', 'staging')).toBe(false);
      expect(validateVersionForNetwork('1.0.0-beta.1', 'development')).toBe(true);
    });

    it('should throw error for invalid version format', () => {
      expect(() => validateVersionForNetwork('invalid', 'production')).toThrow('Invalid version format');
      expect(() => validateVersionForNetwork('1.0', 'production')).toThrow('Invalid version format');
      expect(() => validateVersionForNetwork('v1.0.0', 'production')).toThrow('Invalid version format');
    });
  });

  describe('getRecommendedNetworkForVersion', () => {
    it('should recommend production for major releases', () => {
      expect(getRecommendedNetworkForVersion('1.0.0')).toBe('production');
      expect(getRecommendedNetworkForVersion('2.0.0')).toBe('production');
      expect(getRecommendedNetworkForVersion('10.0.0')).toBe('production');
    });

    it('should recommend staging for minor releases', () => {
      expect(getRecommendedNetworkForVersion('1.1.0')).toBe('staging');
      expect(getRecommendedNetworkForVersion('2.5.0')).toBe('staging');
      expect(getRecommendedNetworkForVersion('10.20.0')).toBe('staging');
    });

    it('should recommend development for patch releases', () => {
      expect(getRecommendedNetworkForVersion('1.0.1')).toBe('development');
      expect(getRecommendedNetworkForVersion('1.1.1')).toBe('development');
      expect(getRecommendedNetworkForVersion('2.3.4')).toBe('development');
    });

    it('should handle pre-release versions correctly', () => {
      // Prereleases only pass the development gate (issue #352), so development is the
      // most restrictive network that accepts any prerelease build.
      expect(getRecommendedNetworkForVersion('1.0.0-beta')).toBe('development');
      expect(getRecommendedNetworkForVersion('1.1.0-alpha')).toBe('development');
      expect(getRecommendedNetworkForVersion('1.1.1-rc.1')).toBe('development');
    });
  });

  describe('Bitcoin Network Mapping', () => {
    describe('WEBVH_NETWORKS Bitcoin mappings', () => {
      it('should map development to regtest', () => {
        expect(WEBVH_NETWORKS.development.bitcoinNetwork).toBe('regtest');
      });

      it('should map staging to signet', () => {
        expect(WEBVH_NETWORKS.staging.bitcoinNetwork).toBe('signet');
      });

      it('should map production to mainnet', () => {
        expect(WEBVH_NETWORKS.production.bitcoinNetwork).toBe('mainnet');
      });
    });

    describe('getBitcoinNetworkForWebVH', () => {
      it('should return regtest for development', () => {
        expect(getBitcoinNetworkForWebVH('development')).toBe('regtest');
      });

      it('should return signet for staging', () => {
        expect(getBitcoinNetworkForWebVH('staging')).toBe('signet');
      });

      it('should return mainnet for production', () => {
        expect(getBitcoinNetworkForWebVH('production')).toBe('mainnet');
      });
    });

    describe('getWebVHNetworkForBitcoin', () => {
      it('should return development for regtest', () => {
        expect(getWebVHNetworkForBitcoin('regtest')).toBe('development');
      });

      it('should return staging for signet', () => {
        expect(getWebVHNetworkForBitcoin('signet')).toBe('staging');
      });

      it('should return production for mainnet', () => {
        expect(getWebVHNetworkForBitcoin('mainnet')).toBe('production');
      });
    });

    describe('Network mapping consistency', () => {
      it('should have bidirectional mapping for all WebVH networks', () => {
        // development ↔ regtest
        const developmentBitcoin = getBitcoinNetworkForWebVH('development');
        expect(getWebVHNetworkForBitcoin(developmentBitcoin)).toBe('development');

        // staging ↔ signet
        const stagingBitcoin = getBitcoinNetworkForWebVH('staging');
        expect(getWebVHNetworkForBitcoin(stagingBitcoin)).toBe('staging');

        // production ↔ mainnet
        const productionBitcoin = getBitcoinNetworkForWebVH('production');
        expect(getWebVHNetworkForBitcoin(productionBitcoin)).toBe('production');
      });

      it('should maintain environment consistency across networks', () => {
        // Development: development → regtest
        expect(getBitcoinNetworkForWebVH('development')).toBe('regtest');

        // Staging: staging → signet
        expect(getBitcoinNetworkForWebVH('staging')).toBe('signet');

        // Production: production → mainnet
        expect(getBitcoinNetworkForWebVH('production')).toBe('mainnet');
      });
    });
  });
});

describe('prerelease versions and network gates (issue #352)', () => {
  it('rejects prereleases on production even when the numeric part is a major release', () => {
    expect(validateVersionForNetwork('2.0.0-rc.1', 'production')).toBe(false);
    expect(validateVersionForNetwork('1.0.0-beta', 'production')).toBe(false);
  });

  it('rejects prereleases on staging', () => {
    expect(validateVersionForNetwork('1.1.0-rc.2', 'staging')).toBe(false);
  });

  it('accepts prereleases on development (all versions)', () => {
    expect(validateVersionForNetwork('2.0.0-rc.1', 'development')).toBe(true);
    expect(validateVersionForNetwork('1.2.3-alpha.4', 'development')).toBe(true);
  });
});
