/**
 * WebVH Network Configuration
 *
 * Defines the three deployment networks for the Originals Protocol:
 * - magby: Development network (patch versions) → Bitcoin regtest
 * - cleffa: Staging network (minor versions) → Bitcoin signet
 * - pichu: Production network (major versions) → Bitcoin mainnet
 */

export type WebVHNetworkName = 'magby' | 'cleffa' | 'pichu';

export type BitcoinNetworkName = 'mainnet' | 'regtest' | 'signet';

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
  magby: {
    name: 'magby',
    domain: 'magby.originals.build',
    stability: 'patch',
    description: 'Development network - accepts all patch versions (most unstable)',
    contextUrl: 'https://magby.originals.build/context',
    bitcoinNetwork: 'regtest', // Development → regtest
  },
  cleffa: {
    name: 'cleffa',
    domain: 'cleffa.originals.build',
    stability: 'minor',
    description: 'Staging network - accepts minor releases',
    contextUrl: 'https://cleffa.originals.build/context',
    bitcoinNetwork: 'signet', // Staging → signet
  },
  pichu: {
    name: 'pichu',
    domain: 'pichu.originals.build',
    stability: 'major',
    description: 'Production network - accepts major releases only (most stable)',
    contextUrl: 'https://pichu.originals.build/context',
    bitcoinNetwork: 'mainnet', // Production → mainnet
  },
};

/**
 * Default network for backward compatibility
 */
export const DEFAULT_WEBVH_NETWORK: WebVHNetworkName = 'pichu';

/**
 * Get network configuration by name
 * @param network - Network name
 * @returns Network configuration
 */
export function getNetworkConfig(network: WebVHNetworkName): WebVHNetworkConfig {
  const config = WEBVH_NETWORKS[network];
  if (!config) {
    throw new Error(`Invalid WebVH network: ${network}. Valid networks: magby, cleffa, pichu`);
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

  // Parse semver (basic parsing, assumes format X.Y.Z)
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected semver format (e.g., 1.2.3)`);
  }

  const [, major, minor, patch] = match;

  switch (config.stability) {
    case 'major':
      // Pichu: Only allow major releases (X.0.0)
      return minor === '0' && patch === '0';

    case 'minor':
      // Cleffa: Allow minor releases (X.Y.0)
      return patch === '0';

    case 'patch':
      // Magby: Allow all versions including patches
      return true;

    default:
      throw new Error(`Unknown stability level: ${config.stability}`);
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
  if (validateVersionForNetwork(version, 'pichu')) {
    return 'pichu';
  }
  if (validateVersionForNetwork(version, 'cleffa')) {
    return 'cleffa';
  }
  return 'magby';
}

/**
 * Get the corresponding Bitcoin network for a WebVH network
 * This ensures consistent environment mapping across the stack:
 * - magby (dev) → regtest (dev)
 * - cleffa (staging) → signet (staging)
 * - pichu (production) → mainnet (production)
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
      return 'pichu';
    case 'signet':
      return 'cleffa';
    case 'regtest':
      return 'magby';
    default:
      return undefined;
  }
}
