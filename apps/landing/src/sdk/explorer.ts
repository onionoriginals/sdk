import type { BtcNetworkFlag } from './network-flag';

/**
 * Where a creator can look their own payment up.
 *
 * Deliberately narrow: a link out to a block explorer is the one place this
 * app points at a third party about someone's money, so it is built from the
 * network flag rather than from anything server-supplied, and it returns null
 * for a network we have no explorer for rather than guessing at a URL.
 */
export function explorerTxUrl(network: BtcNetworkFlag, txid: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;
  if (network === 'mainnet') return `https://mempool.space/tx/${txid}`;
  if (network === 'testnet4') return `https://mempool.space/testnet4/tx/${txid}`;
  return null;
}
