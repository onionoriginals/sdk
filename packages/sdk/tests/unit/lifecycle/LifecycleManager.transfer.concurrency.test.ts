/**
 * Item 3: transferOwnership concurrency guard + batch transfer duplicate
 * detection.
 *
 * transferOwnership was check-then-act across awaits with no in-flight guard
 * (unlike publishToWeb/inscribeOnBitcoin, issue #255): two overlapping
 * transfers of the same asset both passed the layer check and both broadcast
 * paid transactions. And validateBatchTransfer lacked the duplicate-asset
 * check that validateBatchInscription has (issue #243), so the same asset
 * listed twice in a batch would be transferred twice.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { BatchValidator } from '../../../src/lifecycle/BatchOperations';
import { MockOrdinalsProvider } from '../../mocks/adapters';

const VALID_ADDR = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

function makeBtcoAsset(sat: string): OriginalsAsset {
  return new OriginalsAsset(
    [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa11' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:btco:${sat}` } as any,
    []
  );
}

describe('transferOwnership concurrency guard', () => {
  test('a second concurrent transfer of the same asset is rejected with OPERATION_IN_PROGRESS', async () => {
    const provider = new MockOrdinalsProvider();
    // Make the transfer slow so the second call arrives while the first is in flight.
    const origTransfer = provider.transferInscription.bind(provider);
    let transferCalls = 0;
    provider.transferInscription = async (inscriptionId: string, toAddress: string, options?: { feeRate?: number }) => {
      transferCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return origTransfer(inscriptionId, toAddress, options);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = makeBtcoAsset('777001');

    const [first, second] = await Promise.allSettled([
      sdk.lifecycle.transferOwnership(asset, VALID_ADDR),
      sdk.lifecycle.transferOwnership(asset, VALID_ADDR)
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // Exactly one transfer succeeds; the other is rejected by the guard
    // BEFORE broadcasting a second paid transaction.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; message: string };
    expect(reason.code ?? reason.message).toContain('OPERATION_IN_PROGRESS');
    expect(transferCalls).toBe(1);
    // Only one transfer recorded in provenance.
    expect(asset.getProvenance().transfers.length).toBe(1);
  });

  test('the guard is released after a transfer completes (sequential transfers work)', async () => {
    const provider = new MockOrdinalsProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = makeBtcoAsset('777002');

    const tx1 = await sdk.lifecycle.transferOwnership(asset, VALID_ADDR);
    const tx2 = await sdk.lifecycle.transferOwnership(asset, VALID_ADDR);
    expect(typeof tx1.txid).toBe('string');
    expect(typeof tx2.txid).toBe('string');
    expect(asset.getProvenance().transfers.length).toBe(2);
  });

  test('the guard is released after a failed transfer (retry not blocked)', async () => {
    const provider = new MockOrdinalsProvider();
    let failNext = true;
    const origTransfer = provider.transferInscription.bind(provider);
    provider.transferInscription = async (inscriptionId: string, toAddress: string, options?: { feeRate?: number }) => {
      if (failNext) {
        failNext = false;
        throw new Error('broadcast failed');
      }
      return origTransfer(inscriptionId, toAddress, options);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = makeBtcoAsset('777003');

    await expect(sdk.lifecycle.transferOwnership(asset, VALID_ADDR)).rejects.toThrow('broadcast failed');
    // Guard released: the retry reaches the provider instead of OPERATION_IN_PROGRESS.
    const tx = await sdk.lifecycle.transferOwnership(asset, VALID_ADDR);
    expect(typeof tx.txid).toBe('string');
  });
});

describe('validateBatchTransfer duplicate detection', () => {
  test('flags the same asset listed twice in one batch', () => {
    const validator = new BatchValidator();
    const asset = makeBtcoAsset('888001');
    const other = makeBtcoAsset('888002');

    const results = validator.validateBatchTransfer([
      { asset, to: VALID_ADDR },
      { asset: other, to: VALID_ADDR },
      { asset, to: VALID_ADDR } // duplicate of item 0
    ]);

    expect(results[0].isValid).toBe(true);
    expect(results[1].isValid).toBe(true);
    expect(results[2].isValid).toBe(false);
    expect(results[2].errors.join(' ')).toContain('Duplicate asset in batch');
    expect(results[2].errors.join(' ')).toContain('item 0');
  });

  test('distinct assets pass', () => {
    const validator = new BatchValidator();
    const results = validator.validateBatchTransfer([
      { asset: makeBtcoAsset('888003'), to: VALID_ADDR },
      { asset: makeBtcoAsset('888004'), to: VALID_ADDR }
    ]);
    expect(results.every((r) => r.isValid)).toBe(true);
  });
});
