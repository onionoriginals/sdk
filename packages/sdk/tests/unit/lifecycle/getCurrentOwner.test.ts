/**
 * Phase-4 Task 4: LifecycleManager.getCurrentOwner(asset).
 *
 * Ownership = sat control, read LIVE from Bitcoin via
 * OrdinalsProvider.getSatOwnership — never from the CEL (the log is
 * authorship only; #366 ownership-is-sat).
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';

const TO_ADDRESS = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

describe('LifecycleManager.getCurrentOwner', () => {
  test('returns the mock owner right after inscribeOnBitcoin', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '11'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const owner = await sdk.lifecycle.getCurrentOwner(asset);
    expect(owner).not.toBeNull();
    expect(owner!.address).toBe('bcrt1qmockowner');
    expect(typeof owner!.outpoint).toBe('string');
    expect(owner!.outpoint.length).toBeGreaterThan(0);
  });

  test('reflects the NEW address after transferOwnership moves the sat', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '22'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const before = await sdk.lifecycle.getCurrentOwner(asset);
    expect(before!.address).toBe('bcrt1qmockowner');

    await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    const after = await sdk.lifecycle.getCurrentOwner(asset);
    expect(after).not.toBeNull();
    expect(after!.address).toBe(TO_ADDRESS);
    expect(after!.address).not.toBe(before!.address);
  });

  test('returns null for a fresh did:cel asset not yet on did:btco', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '33'.repeat(32) }
    ]);

    expect(await sdk.lifecycle.getCurrentOwner(asset)).toBeNull();
  });

  test('throws ORD_PROVIDER_REQUIRED when the SDK has no ordinalsProvider configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:42' } as any,
      []
    );
    await expect(sdk.lifecycle.getCurrentOwner(asset)).rejects.toMatchObject({ code: 'ORD_PROVIDER_REQUIRED' });
  });

  test('returns null when the configured provider has no getSatOwnership (no owner index)', async () => {
    const provider = new OrdMockProvider();
    // Shadow getSatOwnership (a prototype method — delete wouldn't remove it)
    // to simulate a provider without an owner index, mirroring the
    // resolver's fail-open metadata contract.
    (provider as any).getSatOwnership = undefined;
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    } as any);
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:123456' } as any,
      []
    );

    expect(await sdk.lifecycle.getCurrentOwner(asset)).toBeNull();
  });
});
