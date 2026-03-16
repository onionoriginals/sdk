/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';

describe('LifecycleManager.transferOwnership comprehensive', () => {
  const createSDK = () => {
    const provider = new MockOrdinalsProvider();
    return OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: provider,
    } as any);
  };

  const createBtcoAsset = (id = 'did:btco:42') => {
    return new OriginalsAsset(
      [{ id: 'res1', type: 'image', contentType: 'image/png', hash: 'abc123' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id } as any,
      []
    );
  };

  // Valid testnet bech32 addresses
  const ADDR_A = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const ADDR_B = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

  // --- Happy path ---

  test('transfers btco asset and returns transaction', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    const tx = await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    expect(typeof tx.txid).toBe('string');
    expect(tx.txid.length).toBeGreaterThan(0);
  });

  test('records transfer in provenance', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    const prov = asset.getProvenance();
    expect(prov.transfers.length).toBe(1);
    expect(prov.transfers[0].to).toBe(ADDR_A);
    expect(prov.transfers[0].transactionId).toBeTruthy();
  });

  test('provenance transfer includes from address', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    const prov = asset.getProvenance();
    expect(prov.transfers[0].from).toBe('did:btco:42');
  });

  test('provenance transfer includes timestamp', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    const prov = asset.getProvenance();
    expect(prov.transfers[0].timestamp).toBeTruthy();
    // Should be valid ISO date
    expect(new Date(prov.transfers[0].timestamp).getTime()).not.toBeNaN();
  });

  test('asset remains on did:btco layer after transfer', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    expect(asset.currentLayer).toBe('did:btco');
  });

  test('preserves resources after transfer', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    const originalResources = [...asset.resources];
    await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    expect(asset.resources).toEqual(originalResources);
  });

  // --- Multiple transfers ---

  test('supports sequential transfers to different addresses', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();

    const tx1 = await sdk.lifecycle.transferOwnership(asset, ADDR_A);
    const tx2 = await sdk.lifecycle.transferOwnership(asset, ADDR_B);

    const prov = asset.getProvenance();
    expect(prov.transfers.length).toBe(2);
    expect(prov.transfers[0].to).toBe(ADDR_A);
    expect(prov.transfers[1].to).toBe(ADDR_B);
    expect(typeof tx1.txid).toBe('string');
    expect(typeof tx2.txid).toBe('string');
  });

  test('provenance chain is ordered chronologically', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();

    await sdk.lifecycle.transferOwnership(asset, ADDR_A);
    await sdk.lifecycle.transferOwnership(asset, ADDR_B);

    const prov = asset.getProvenance();
    const t1 = new Date(prov.transfers[0].timestamp).getTime();
    const t2 = new Date(prov.transfers[1].timestamp).getTime();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  // --- Layer validation ---

  test('throws if asset is on did:peer', async () => {
    const sdk = createSDK();
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:z6MkTest1' } as any,
      []
    );
    await expect(
      sdk.lifecycle.transferOwnership(asset, ADDR_A)
    ).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });

  test('throws if asset is on did:webvh', async () => {
    const sdk = createSDK();
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:test' } as any,
      []
    );
    await expect(
      sdk.lifecycle.transferOwnership(asset, ADDR_A)
    ).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });

  // --- Input validation ---

  test('throws on null asset', async () => {
    const sdk = createSDK();
    await expect(sdk.lifecycle.transferOwnership(null as any, ADDR_A)).rejects.toThrow();
  });

  test('throws on empty newOwner string', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await expect(sdk.lifecycle.transferOwnership(asset, '')).rejects.toThrow('Invalid newOwner');
  });

  test('throws on null newOwner', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await expect(sdk.lifecycle.transferOwnership(asset, null as any)).rejects.toThrow('Invalid newOwner');
  });

  test('throws on invalid Bitcoin address format', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    await expect(
      sdk.lifecycle.transferOwnership(asset, 'not-a-bitcoin-address')
    ).rejects.toThrow('Invalid Bitcoin address');
  });

  // --- Transaction structure ---

  test('returned transaction has expected structure', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    const tx = await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    expect(tx).toHaveProperty('txid');
    expect(tx).toHaveProperty('vin');
    expect(tx).toHaveProperty('vout');
    expect(tx).toHaveProperty('fee');
    expect(Array.isArray(tx.vin)).toBe(true);
    expect(Array.isArray(tx.vout)).toBe(true);
    expect(typeof tx.fee).toBe('number');
  });

  test('transaction vout includes recipient address', async () => {
    const sdk = createSDK();
    const asset = createBtcoAsset();
    const tx = await sdk.lifecycle.transferOwnership(asset, ADDR_A);

    const recipientOutput = tx.vout.find(v => v.address === ADDR_A);
    expect(recipientOutput).toBeDefined();
  });

  // --- Provenance integrity ---

  test('inscription + transfer creates full provenance chain', async () => {
    const sdk = createSDK();
    const asset = new OriginalsAsset(
      [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'h1' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:chain' } as any,
      []
    );

    // Inscribe first
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    expect(asset.currentLayer).toBe('did:btco');

    // Then transfer
    const tx = await sdk.lifecycle.transferOwnership(asset, ADDR_A);
    expect(typeof tx.txid).toBe('string');

    const prov = asset.getProvenance();
    expect(prov.migrations.length).toBeGreaterThanOrEqual(1);
    expect(prov.transfers.length).toBe(1);

    // Migration should show webvh -> btco
    const lastMigration = prov.migrations[prov.migrations.length - 1];
    expect(lastMigration.to).toBe('did:btco');

    // Transfer should reference the new owner
    expect(prov.transfers[0].to).toBe(ADDR_A);
  });
});
