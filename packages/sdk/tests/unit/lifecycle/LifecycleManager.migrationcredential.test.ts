import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';

describe('publication credential is signed by the asset peer key (#365)', () => {
  test('issuer is the peer DID and subject records migratedTo', async () => {
    // OriginalsSDK.create does not wire a keyStore by default; supply one so
    // createAsset registers the asset's peer key (the previous-layer key that
    // must countersign the peer -> webvh migration).
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore()
    });
    // createAsset validates inline content against the declared hash (#347),
    // so declare the real sha256 of the content rather than a fake hash.
    const content = 'x';
    const hash = bytesToHex(sha256(new TextEncoder().encode(content)));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash, content }
    ]);
    const peerDid = asset.id;
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const cred = published.credentials.find(c => (c.type as string[]).includes('ResourceMigrated'));
    expect(cred).toBeDefined();
    const issuer = typeof cred!.issuer === 'string' ? cred!.issuer : cred!.issuer.id;
    expect(issuer).toBe(peerDid);
    const subject = cred!.credentialSubject as { id: string; migratedTo?: string };
    expect(subject.id).toBe(peerDid);
    expect(subject.migratedTo).toBe(published.bindings!['did:webvh']);
  });
});
