import { expect } from '@jest/globals';
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';

const resources = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'deadbeef'
  }
];

describe('LifecycleManager', () => {
  test('createAsset creates a peer-layer asset', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset(resources);
    expect(asset.currentLayer).toBe('did:peer');
    expect(asset.id.startsWith('did:peer:')).toBe(true);
  });

  test('publishToWeb migrates and records binding', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset(resources);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.bindings?.['did:webvh']).toContain('example.com');
  });

  test('inscribeOnBitcoin uses provider details for provenance', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = await sdk.lifecycle.createAsset(resources);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const btco = await sdk.lifecycle.inscribeOnBitcoin(asset, 9);
    expect(btco.currentLayer).toBe('did:btco');
    const provenance = btco.getProvenance();
    const latest = provenance.migrations[provenance.migrations.length - 1];
    expect(latest.inscriptionId).toBe('insc-mock');
    expect(latest.satoshi).toBe('123');
    expect(latest.transactionId).toBe('tx-reveal-mock');
    expect(latest.feeRate).toBe(9);
    expect(btco.bindings?.['did:btco']).toBe('did:btco:123');
  });

  test('inscribeOnBitcoin without provider still migrates', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset(resources);
    const btco = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    expect(btco.currentLayer).toBe('did:btco');
  });

  test('inscribeOnBitcoin enforces migration guard', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const fakeAsset = { currentLayer: 'did:webvh', migrate: undefined } as unknown as OriginalsAsset;
    await expect(sdk.lifecycle.inscribeOnBitcoin(fakeAsset, 5)).rejects.toThrow('Not implemented');
  });

  test('publishToWeb throws Not implemented (coverage for throw)', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const fakeAsset: any = { currentLayer: 'did:peer' };
    await expect(
      sdk.lifecycle.publishToWeb(fakeAsset, 'example.com')
    ).rejects.toThrow();
  });

  test('inscribeOnBitcoin throws Not implemented (coverage for throw)', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const fakeAsset: any = { currentLayer: 'did:webvh' };
    await expect(
      sdk.lifecycle.inscribeOnBitcoin(fakeAsset, 10)
    ).rejects.toThrow('Not implemented');
  });

  test('transferOwnership succeeds when on btco (returns tx)', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa' }
    ]);
    await asset.migrate('did:btco');
    const tx = await sdk.lifecycle.transferOwnership(asset as any, 'bc1qaddress');
    expect(typeof tx.txid).toBe('string');
  });

  test('transferOwnership errors if not on btco layer', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    // This one should pass given current guard
    const asset = await (async () => {
      try {
        return await sdk.lifecycle.createAsset(resources);
      } catch (e) {
        // Fallback mock minimal object to hit the guard branch
        return { currentLayer: 'did:webvh' } as any;
      }
    })();
    await expect(
      sdk.lifecycle.transferOwnership(asset as any, 'bc1qnewowner')
    ).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });
});

/** Inlined from LifecycleManager.btco.psbt.part.ts */
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




/** Inlined from LifecycleManager.coverage-branches.part.ts */
import { LifecycleManager } from '../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../src/did/DIDManager';
import { CredentialManager } from '../../src/vc/CredentialManager';

describe('LifecycleManager additional branch coverage', () => {
  const lm = new LifecycleManager({ network: 'mainnet' } as any, new DIDManager({} as any), new CredentialManager({} as any));

  test('publishToWeb throws when migrate not a function', async () => {
    const asset: any = { currentLayer: 'did:peer' };
    await expect(lm.publishToWeb(asset, 'example.com')).rejects.toThrow('Not implemented');
  });
});




/** Inlined from LifecycleManager.more.part.ts */

const dummyConfig: any = {};
const didManager = new DIDManager(dummyConfig as any);
const credentialManager = new CredentialManager(dummyConfig as any);
const lm = new LifecycleManager(dummyConfig as any, didManager, credentialManager);

describe('LifecycleManager additional branches', () => {
  test('publishToWeb throws when currentLayer is not did:peer', async () => {
    const asset: any = { currentLayer: 'did:webvh', migrate: async () => { } };
    await expect(lm.publishToWeb(asset, 'example.com')).rejects.toThrow();
  });

  test('inscribeOnBitcoin throws for invalid layer', async () => {
    const asset: any = { currentLayer: 'did:wrong', migrate: async () => { } };
    await expect(lm.inscribeOnBitcoin(asset)).rejects.toThrow('Not implemented');
  });
});




/** Inlined from LifecycleManager.no-feeRate.part.ts */

describe('LifecycleManager.inscribeOnBitcoin without explicit feeRate', () => {
  test('uses provider.estimateFee when feeRate not provided', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord' });
    const asset = await sdk.lifecycle.createAsset([{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa' }]);
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(result.currentLayer).toBe('did:btco');
    expect((result as any).provenance.feeRate).toBeGreaterThan(0);
    test('transferOwnership uses provenance inscription data', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
      const asset = await sdk.lifecycle.createAsset(resources);
      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      await sdk.lifecycle.inscribeOnBitcoin(asset, 8);
      const tx = await sdk.lifecycle.transferOwnership(asset, 'bcrt1qdestination');
      expect(tx.txid).toBe('tx-transfer-mock');
      const provenance = asset.getProvenance();
      expect(provenance.transfers[provenance.transfers.length - 1].transactionId).toBe('tx-transfer-mock');
    });
  })
});
