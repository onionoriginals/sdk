import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import type { OrdinalsProvider } from '../../../src/adapters';
import { scriptPubKeyForAddress } from '../../../src/bitcoin/transfer';

// A valid regtest (bech32 'bcrt') P2WPKH destination address.
const TO_ADDRESS = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

/**
 * Provider whose transferInscription deliberately omits `vout`, forcing
 * BitcoinManager.transferInscription onto its fallback-output code path.
 */
const createNoVoutProvider = (): OrdinalsProvider =>
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
    async transferInscription(_id: string, toAddress: string, options?: { feeRate?: number }) {
      // Intentionally return NO vout -> exercises the fallback branch.
      return {
        txid: 'tx-transfer',
        vin: [{ txid: 'tx-out', vout: 0 }],
        vout: [] as Array<{ value: number; scriptPubKey: string; address?: string }>,
        fee: options?.feeRate ? Math.round(options.feeRate) : 100,
        satoshi: '123456789',
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

describe('BitcoinManager.transferInscription fallback output scriptPubKey', () => {
  test('derives a valid hex scriptPubKey from the destination address (not a placeholder)', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: createNoVoutProvider()
    } as any);

    const tx = await sdk.bitcoin.transferInscription(
      {
        inscriptionId: 'insc-test',
        satoshi: '123456789',
        txid: 'tx-out',
        vout: 0
      } as any,
      TO_ADDRESS
    );

    expect(tx.vout.length).toBe(1);
    const script = tx.vout[0].scriptPubKey;

    // Must NOT be the old placeholder.
    expect(script).not.toBe('script');

    // Must be valid, non-empty, lowercase hex.
    expect(script.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(script)).toBe(true);
    // Hex strings have even length and round-trip through Buffer.
    expect(script.length % 2).toBe(0);
    expect(Buffer.from(script, 'hex').toString('hex')).toBe(script);

    // Must equal the script genuinely derived from the destination address.
    expect(script).toBe(scriptPubKeyForAddress(TO_ADDRESS, 'regtest'));
  });
});
