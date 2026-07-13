/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';

describe('LifecycleManager.inscribeOnBitcoin', () => {
  const createSDK = (opts?: { feeOracle?: { estimateFeeRate: () => Promise<number> } }) => {
    const provider = new MockOrdinalsProvider();
    return OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: provider,
      ...opts,
    } as any);
  };

  const createAssetAtLayer = (layer: string, id?: string) => {
    const didId = id ?? (layer === 'did:peer' ? 'did:peer:z6MkTestPeer1' : 'did:webvh:example.com:asset1');
    return new OriginalsAsset(
      [{ id: 'res1', type: 'image', contentType: 'image/png', hash: 'abc123' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: didId } as any,
      []
    );
  };

  // --- Happy path tests ---

  test('inscribes did:webvh asset and migrates to did:btco', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
    expect(result).toBe(asset); // Returns same asset object, mutated
  });

  test('inscribes did:peer asset directly to did:btco', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:peer');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
  });

  test('records migration in provenance with transaction details', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const prov = asset.getProvenance();
    expect(prov.migrations.length).toBeGreaterThanOrEqual(1);
    const migration = prov.migrations[prov.migrations.length - 1];
    expect(migration.from).toBe('did:webvh');
    expect(migration.to).toBe('did:btco');
    expect(migration.transactionId).toBeTruthy();
    expect(migration.inscriptionId).toBeTruthy();
  });

  test('stores satoshi in provenance migration', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const prov = asset.getProvenance();
    const migration = prov.migrations[prov.migrations.length - 1];
    expect(migration.satoshi).toBeTruthy();
  });

  test('sets did:btco binding on asset', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(asset.bindings).toBeDefined();
    expect(asset.bindings!['did:btco']).toMatch(/^did:btco:/);
  });

  test('works without explicit feeRate (uses default)', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset);

    expect(result.currentLayer).toBe('did:btco');
  });

  test('uses feeOracle when configured and no explicit feeRate is given', async () => {
    const sdk = createSDK({ feeOracle: { estimateFeeRate: async () => 42 } });
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const prov = asset.getProvenance();
    const migration = prov.migrations[prov.migrations.length - 1];
    expect(migration.feeRate).toBe(42);
  });

  test('an explicit feeRate wins over the feeOracle', async () => {
    const sdk = createSDK({ feeOracle: { estimateFeeRate: async () => 42 } });
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const prov = asset.getProvenance();
    const migration = prov.migrations[prov.migrations.length - 1];
    expect(migration.feeRate).toBe(5);
  });

  test('preserves existing resources after inscription', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    const originalResources = [...asset.resources];
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(asset.resources).toEqual(originalResources);
  });

  test('manifest includes correct assetId and resources', async () => {
    const sdk = createSDK();
    const asset = new OriginalsAsset(
      [
        { id: 'r1', type: 'image', contentType: 'image/png', hash: 'hash1' },
        { id: 'r2', type: 'text', contentType: 'text/plain', hash: 'hash2' },
      ],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:multi' } as any,
      []
    );
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    // Asset should be inscribed with all resources
    expect(result.currentLayer).toBe('did:btco');
    expect(result.resources.length).toBe(2);
  });

  // --- Validation tests ---

  test('throws on null asset', async () => {
    const sdk = createSDK();
    await expect(sdk.lifecycle.inscribeOnBitcoin(null as any, 5)).rejects.toThrow();
  });

  test('throws on non-object asset', async () => {
    const sdk = createSDK();
    await expect(sdk.lifecycle.inscribeOnBitcoin('not-an-asset' as any, 5)).rejects.toThrow();
  });

  test('throws on negative feeRate', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, -1)).rejects.toThrow('Invalid feeRate');
  });

  test('throws on zero feeRate', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 0)).rejects.toThrow('Invalid feeRate');
  });

  test('throws on feeRate exceeding max', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 1000001)).rejects.toThrow('Invalid feeRate');
  });

  test('throws on NaN feeRate', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, NaN)).rejects.toThrow('Invalid feeRate');
  });

  test('throws on Infinity feeRate', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, Infinity)).rejects.toThrow('Invalid feeRate');
  });

  // --- Layer transition tests ---

  test('throws if asset already on did:btco', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:btco', 'did:btco:42');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 5)).rejects.toThrow();
  });

  test('double inscription fails (already migrated)', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    expect(asset.currentLayer).toBe('did:btco');

    // Second inscription should fail
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 5)).rejects.toThrow();
  });

  // --- Boundary fee rate tests ---

  test('accepts minimum feeRate of 1', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 1);
    expect(result.currentLayer).toBe('did:btco');
  });

  test('accepts reasonable high feeRate of 500', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 500);
    expect(result.currentLayer).toBe('did:btco');
  });

  test('rejects feeRate exceeding BitcoinManager limit', async () => {
    const sdk = createSDK();
    const asset = createAssetAtLayer('did:webvh');
    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 1000000)).rejects.toThrow();
  });

  // --- Deferred-content provider (buildContent, no `content` in response) ---

  test('sets prefix-derived btco binding when provider omits inscription content', async () => {
    // Conformant provider: supports buildContent but returns no `content`.
    // The binding derivation must not choke parsing a missing/function content;
    // it falls back to the prefix-derived did:btco id without throwing.
    let sat = 5000;
    const provider = {
      async createInscription({ buildContent }: { buildContent: (s: string) => Buffer | Promise<Buffer> }) {
        const satoshi = String(sat++);
        await buildContent(satoshi);
        return { inscriptionId: `insc-${satoshi}`, txid: `tx-${satoshi}`, satoshi };
      }
    };
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
    const binding = asset.bindings?.['did:btco'];
    expect(binding).toBeDefined();
    expect(binding!.startsWith('did:btco:reg:')).toBe(true);
  });

  // --- Provider-echo integrity: never trust the echoed DID id for the binding ---

  test('ignores tampered echoed content: binding is derivation-computed, not the provider echo', async () => {
    // Compromised provider echoes a DID id it did not create ("did:btco:999999999")
    // while the real inscription lands on a different satoshi. The binding must be
    // computed from the configured network + real satoshi, NOT the echoed id.
    let sat = 7000;
    const provider = {
      async createInscription({ buildContent }: { buildContent: (s: string) => Buffer | Promise<Buffer> }) {
        const satoshi = String(sat++);
        // Provider is asked to build honest content but returns tampered bytes.
        await buildContent(satoshi);
        return {
          inscriptionId: `insc-${satoshi}`,
          txid: `tx-${satoshi}`,
          satoshi,
          content: Buffer.from(JSON.stringify({ id: 'did:btco:999999999' })),
        };
      }
    };
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = createAssetAtLayer('did:webvh');
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
    const binding = asset.bindings?.['did:btco'];
    // The real satoshi assigned was 7000 (first allocation).
    expect(binding).toBe('did:btco:reg:7000');
    expect(binding).not.toBe('did:btco:999999999');
  });

  // --- Review fix: ORD_SATOSHI_UNKNOWN must not leave a captured btco doc behind ---

  test('ORD_SATOSHI_UNKNOWN: no did:btco doc is captured for serialize() after rollback', async () => {
    // Provider's createInscription invokes buildContent (so the btco DID doc IS
    // built, mirroring the real inscribeData deferred-content path) but returns
    // no satoshi and offers no way to resolve one — the real BitcoinManager
    // throws ORD_SATOSHI_UNKNOWN in that case. The doc must never have been
    // captured into the asset's #didDocuments (no rollback exists for it).
    const provider = {
      async createInscription({ buildContent }: { buildContent: (s: string) => Buffer | Promise<Buffer> }) {
        await buildContent('999999');
        return { inscriptionId: 'insc-nosat', txid: 'tx-nosat' };
      }
    };
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: provider,
      keyStore: new (await import('../../mocks/MockKeyStore')).MockKeyStore()
    } as any);
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);

    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 5)).rejects.toThrow();

    const env = asset.serialize();
    expect(env.didDocuments['did:btco']).toBeUndefined();
  });
});
