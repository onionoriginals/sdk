/**
 * WebVH Network Configuration
 *
 * Defines named compatibility profiles for version stability and Bitcoin selection.
 * All profiles use the canonical Originals context; they do not select a
 * deployment hostname. DID creation still requires an explicit domain.
 * - development: Development network (patch versions) → Bitcoin regtest
 * - staging: Staging network (minor versions) → Bitcoin signet
 * - production: Production network (major versions) → Bitcoin mainnet
 */

export type WebVHNetworkName = 'development' | 'staging' | 'production';

export type BitcoinNetworkName = 'mainnet' | 'testnet' | 'regtest' | 'signet';

export type VersionStability = 'patch' | 'minor' | 'major';

export interface WebVHNetworkConfig {
  name: WebVHNetworkName;
  domain: string;
  stability: VersionStability;
  description: string;
  contextUrl: string;
  bitcoinNetwork: BitcoinNetworkName; // Corresponding Bitcoin network for did:btco migrations
}

/**
 * Network configurations for the Originals Protocol WebVH deployments
 */
export const WEBVH_NETWORKS: Record<WebVHNetworkName, WebVHNetworkConfig> = {
  development: {
    name: 'development',
    domain: 'originals.build',
    stability: 'patch',
    description: 'Development network - accepts all patch versions (most unstable)',
    contextUrl: 'https://originals.build/context',
    bitcoinNetwork: 'regtest', // Development → regtest
  },
  staging: {
    name: 'staging',
    domain: 'originals.build',
    stability: 'minor',
    description: 'Staging network - accepts minor releases',
    contextUrl: 'https://originals.build/context',
    bitcoinNetwork: 'signet', // Staging → signet
  },
  production: {
    name: 'production',
    domain: 'originals.build',
    stability: 'major',
    description: 'Production network - accepts major releases only (most stable)',
    contextUrl: 'https://originals.build/context',
    bitcoinNetwork: 'mainnet', // Production → mainnet
  },
};

/**
 * Default production profile
 */
export const DEFAULT_WEBVH_NETWORK: WebVHNetworkName = 'production';

/**
 * Get network configuration by name
 * @param network - Network name
 * @returns Network configuration
 */
export function getNetworkConfig(network: WebVHNetworkName): WebVHNetworkConfig {
  const config = WEBVH_NETWORKS[network];
  if (!config) {
    throw new Error(`Invalid WebVH network: ${network}. Valid networks: development, staging, production`);
  }
  return config;
}

/**
 * Get network domain
 * @param network - Network name
 * @returns Network domain
 */
export function getNetworkDomain(network: WebVHNetworkName): string {
  return getNetworkConfig(network).domain;
}

/**
 * Get network context URL
 * @param network - Network name
 * @returns Context URL for the network
 */
export function getNetworkContextUrl(network: WebVHNetworkName): string {
  return getNetworkConfig(network).contextUrl;
}

/**
 * Validate that a version string matches the network's stability requirements
 * @param version - Semver version string (e.g., "1.2.3")
 * @param network - Network name
 * @returns True if the version is allowed on this network
 */
export function validateVersionForNetwork(version: string, network: WebVHNetworkName): boolean {
  const config = getNetworkConfig(network);

  // Parse semver (basic parsing, assumes format X.Y.Z with optional prerelease)
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected semver format (e.g., 1.2.3)`);
  }

  const [, , minor, patch, prerelease] = match;

  // A prerelease (e.g. 2.0.0-rc.1) is NOT a release: it must not pass the
  // production "major releases only" or staging "minor releases" gates just because
  // its numeric part matches (issue #352). Only development (all versions) accepts
  // prereleases.
  if (prerelease && config.stability !== 'patch') {
    return false;
  }

  switch (config.stability) {
    case 'major':
      // Production: Only allow major releases (X.0.0)
      return minor === '0' && patch === '0';

    case 'minor':
      // Staging: Allow minor releases (X.Y.0)
      return patch === '0';

    case 'patch':
      // Development: Allow all versions including patches
      return true;

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.stability;
      throw new Error(`Unknown stability level: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Get the appropriate network for a given version
 * Returns the most restrictive network that accepts this version
 * @param version - Semver version string
 * @returns Recommended network name
 */
export function getRecommendedNetworkForVersion(version: string): WebVHNetworkName {
  // Try networks from most restrictive to least restrictive
  if (validateVersionForNetwork(version, 'production')) {
    return 'production';
  }
  if (validateVersionForNetwork(version, 'staging')) {
    return 'staging';
  }
  return 'development';
}

/**
 * Get the corresponding Bitcoin network for a WebVH network
 * This ensures consistent environment mapping across the stack:
 * - development (dev) → regtest (dev)
 * - staging (staging) → signet (staging)
 * - production (production) → mainnet (production)
 *
 * @param webvhNetwork - WebVH network name
 * @returns Corresponding Bitcoin network name
 */
export function getBitcoinNetworkForWebVH(webvhNetwork: WebVHNetworkName): BitcoinNetworkName {
  return getNetworkConfig(webvhNetwork).bitcoinNetwork;
}

/**
 * Get the WebVH network that corresponds to a Bitcoin network
 * This is the reverse mapping of getBitcoinNetworkForWebVH
 *
 * @param bitcoinNetwork - Bitcoin network name
 * @returns Corresponding WebVH network name, or undefined if no mapping exists
 */
export function getWebVHNetworkForBitcoin(bitcoinNetwork: BitcoinNetworkName): WebVHNetworkName | undefined {
  switch (bitcoinNetwork) {
    case 'mainnet':
      return 'production';
    case 'signet':
      return 'staging';
    case 'regtest':
      return 'development';
    default:
      return undefined;
  }
}
