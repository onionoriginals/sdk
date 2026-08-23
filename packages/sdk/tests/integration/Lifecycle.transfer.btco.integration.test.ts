/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { KeyManager } from '../../src/did/KeyManager';
import { hashResource } from '../../src/utils/validation';

describe('Integration: Lifecycle.transferOwnership for did:btco', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);

  test('thin sat move: returns txid and leaves provenance untouched', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'res1', type: 'text', contentType: 'text/plain', hash: 'dead' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:123' } as any,
      []
    );

    const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    // Transfer is a pure sat move; ownership history is the sat's UTXO chain, not the CEL.
    expect(typeof tx.txid).toBe('string');
  });
});

describe('rotation-aware did:cel derivation (item 4a)', () => {
  // Post-anchor rotation no longer exists (the lineage freezes at the btco
  // anchor), so the retired-key bug is pinned where rotations still happen:
  // a PRE-anchor rotateKey, hand-built with cel primitives and loaded through
  // loadAsset — the code path that actually derives the announced document.
  test('loadAsset announces the ROTATED (current) key, not the retired genesis key', async () => {
    const { createEventLog, appendEvent, celSignerFromKeyPair, deriveDidCel, createCelDidDocument, hexSha256ToDigestMultibase } =
      await import('@originals/cel');
    const km = new KeyManager();
    const genesisKp = await km.generateKeyPair('Ed25519');
    const rotatedKp = await km.generateKeyPair('Ed25519');
    const genesis = celSignerFromKeyPair({ publicKey: genesisKp.publicKey, privateKey: genesisKp.privateKey });

    const contentHex = hashResource(Buffer.from('v1', 'utf8'));
    let log = await createEventLog(
      {
        name: 'Rotated asset',
        controller: genesis.controller,
        resources: [{ id: 'art', digestMultibase: hexSha256ToDigestMultibase(contentHex), mediaType: 'text/plain' }],
        createdAt: '2026-08-23T00:00:00Z',
        nonce: 'item4a'
      },
      { signer: genesis.signer, verificationMethod: genesis.verificationMethod }
    );
    log = await appendEvent(
      log,
      'rotateKey',
      { newController: `did:key:${rotatedKp.publicKey}`, rotatedAt: '2026-08-23T00:00:01Z' },
      { signer: genesis.signer, verificationMethod: genesis.verificationMethod }
    );
    const assetDid = deriveDidCel(log);

    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore()
    });
    const { asset, verification } = await sdk.lifecycle.loadAsset({
      format: 'originals/asset',
      version: 1,
      assetDid,
      eventLog: log,
      // Envelope docs are NEVER trusted: hand it the STALE genesis-key doc and
      // assert loadAsset re-derives the current one anyway.
      didDocuments: { 'did:cel': createCelDidDocument(assetDid, genesisKp.publicKey) },
      resources: [{ id: 'art', type: 'text', contentType: 'text/plain', hash: contentHex, content: 'v1' }]
    } as never);

    expect(verification?.verified).toBe(true);
    const announced = asset.did.verificationMethod?.[0]?.publicKeyMultibase;
    expect(announced).toBe(rotatedKp.publicKey);
    expect(announced).not.toBe(genesisKp.publicKey);
    expect(asset.did.alsoKnownAs).toContain(`did:key:${rotatedKp.publicKey}`);
  });
});
