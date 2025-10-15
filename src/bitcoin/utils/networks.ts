/**
 * Network utilities for Bitcoin operations
 * Ported from legacy ordinalsplus
 */

import * as btc from '@scure/btc-signer';

/**
 * Supported Bitcoin networks
 */
export type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';

/**
 * Network parameters for different Bitcoin networks
 */
export const NETWORKS: Record<BitcoinNetwork, typeof btc.NETWORK> = {
  mainnet: btc.NETWORK,
  testnet: btc.TEST_NETWORK,
  regtest: {
    ...btc.TEST_NETWORK,
    bech32: 'bcrt',
  },
  signet: {
    ...btc.TEST_NETWORK,
    bech32: 'tb',
  },
};

/**
 * Get the scure-btc-signer network object for a given network name
 * 
 * @param network - The network name
 * @returns The scure-btc-signer Network object
 */
export function getScureNetwork(network: BitcoinNetwork): typeof btc.NETWORK {
  return NETWORKS[network] || btc.NETWORK;
}
