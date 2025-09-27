import { OriginalsSDK } from '../../src';
import { BroadcastClient } from '../../src/bitcoin/BroadcastClient';
import { PSBTBuilder } from '../../src/bitcoin/PSBTBuilder';

describe('Bitcoin inscription MVP - dry run', () => {
  test('dry-run using mocked provider and broadcaster', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord' });

    // Inject mocked dependencies
    const mockBroadcast = new BroadcastClient(async (_hex) => 'tx-dryrun', async (_txid) => ({ confirmed: true, confirmations: 1 }));
    const mockPsbt = new PSBTBuilder();

    // @ts-ignore access internals for test injection
    sdk.lifecycle = new (sdk.lifecycle.constructor as any)(
      (sdk as any).lifecycle['config'],
      (sdk as any).lifecycle['didManager'],
      (sdk as any).lifecycle['credentialManager'],
      { broadcastClient: mockBroadcast, psbtBuilder: mockPsbt }
    );

    const asset = await sdk.lifecycle.createAsset([
      { id: 'r1', type: 'text', contentType: 'text/plain', hash: 'aa' }
    ]);

    const before = asset.currentLayer;
    const feeRate = 7;
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, feeRate);

    expect(result.currentLayer).toBe('did:btco');
    expect((result as any).provenance).toEqual(expect.objectContaining({ feeRate }));
    expect((result as any).provenance.txid).toBe('tx-dryrun');
    expect(before).toBe('did:peer');
  });
});

