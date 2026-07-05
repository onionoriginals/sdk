import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import type { OrdinalsProvider } from '../../../src/adapters';

// A valid regtest (bech32 'bcrt') P2WPKH destination address.
const TO_ADDRESS = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

/**
 * Provider whose transferInscription reports only a txid (no vin/vout), which
 * is a realistic response from a provider that only exposes the broadcast id.
 * BitcoinManager must NOT fabricate transaction data to fill the gaps.
 */
const createNoVinVoutProvider = (): OrdinalsProvider =>
  ({
    async createInscription({ data, contentType }: any) {
      return {
        inscriptionId: 'insc-test',
        revealTxId: 'tx-reveal',
        txid: 'tx-out',
        vout: 0,
        satoshi: '123456789',
        content: data,
        contentType
      };
    },
    async getInscriptionById(id: string) {
      return {
        inscriptionId: id,
        content: Buffer.from('x'),
        contentType: 'text/plain',
        txid: 'tx-out',
        vout: 0,
        satoshi: '123456789'
      };
    },
    async transferInscription(_id: string, _toAddress: string, options?: { feeRate?: number }) {
      // Provider reports only the txid — no vin, no vout, and a NEW satoshi.
      return {
        txid: 'tx-transfer',
        fee: options?.feeRate ? Math.round(options.feeRate) : 100,
        satoshi: '999999999',
        confirmations: 0
      };
    },
    async getInscriptionsBySatoshi() {
      return [];
    },
    async broadcastTransaction() {
      return 'tx-broadcast';
    },
    async getTransactionStatus() {
      return { confirmed: false };
    },
    async estimateFee(blocks = 1) {
      return 5 * blocks;
    }
  } as unknown as OrdinalsProvider);

describe('BitcoinManager.transferInscription returns only provider-attested data (#290)', () => {
  test('does not fabricate vin/vout and does not mutate the caller inscription', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: createNoVinVoutProvider()
    } as any);

    const inscription = {
      inscriptionId: 'insc-test',
      satoshi: '123456789',
      txid: 'tx-out',
      vout: 0
    } as any;

    const tx = await sdk.bitcoin.transferInscription(inscription, TO_ADDRESS);

    // Provider attested only the txid; inputs/outputs are unknown, so they must
    // be empty rather than invented from the caller's stale data or a made-up
    // dust value.
    expect(tx.txid).toBe('tx-transfer');
    expect(tx.vin).toEqual([]);
    expect(tx.vout).toEqual([]);

    // The caller's inscription object must be untouched — the old code wrote
    // `inscription.satoshi = response.satoshi`, silently rewriting the caller's
    // record to the provider's (here different) value.
    expect(inscription.satoshi).toBe('123456789');
  });
});
