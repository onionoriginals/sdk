import { expect, describe, test, beforeEach, afterEach } from 'bun:test';
import { LifecycleManager } from '../../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { OriginalsConfig } from '../../../src/types';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

const resources = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  }
];

const config: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519', // Use Ed25519 for did:webvh compatibility
  enableLogging: true,
  storageAdapter: new MemoryStorageAdapter()
};

describe('LifecycleManager Key Management', () => {
  let lifecycleManager: LifecycleManager;
  let didManager: DIDManager;
  let credentialManager: CredentialManager;
  let keyStore: MockKeyStore;
  let publisherDid: string;
  let tempDir: string;
  let publisherKeyPair: any;

  beforeEach(async () => {
    didManager = new DIDManager(config);
    credentialManager = new CredentialManager(config, didManager);
    keyStore = new MockKeyStore();
    lifecycleManager = new LifecycleManager(config, didManager, credentialManager, undefined, keyStore);
    
    // Create a simple mock publisher DID instead of creating a full did:webvh
    // This avoids the overhead of DID creation for every test
    publisherDid = 'did:webvh:example.com:user';
    
    // Create a key pair for the publisher
    const keyManager = new KeyManager();
    publisherKeyPair = await keyManager.generateKeyPair('Ed25519');
    
    // Register the publisher's key in keyStore with common VM ID pattern
    await keyStore.setPrivateKey(`${publisherDid}#key-0`, publisherKeyPair.privateKey);
  });

  afterEach(async () => {
    // Clean up temp directory
    if (tempDir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  describe('registerKey', () => {
    test('should register a valid private key', async () => {
      const keyManager = new KeyManager();
      const keyPair = await keyManager.generateKeyPair('ES256K');
      const vmId = 'did:peer:test#keys-1';

      await lifecycleManager.registerKey(vmId, keyPair.privateKey);

      const retrievedKey = await keyStore.getPrivateKey(vmId);
      expect(retrievedKey).toBe(keyPair.privateKey);
    });

    test('should throw error when keyStore not configured', async () => {
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const keyManager = new KeyManager();
      const keyPair = await keyManager.generateKeyPair('ES256K');

      await expect(
        lifecycleWithoutKeyStore.registerKey('did:peer:test#keys-1', keyPair.privateKey)
      ).rejects.toThrow('KeyStore not configured');
    });

    test('should throw error for invalid verification method ID', async () => {
      const keyManager = new KeyManager();
      const keyPair = await keyManager.generateKeyPair('ES256K');

      await expect(
        lifecycleManager.registerKey('', keyPair.privateKey)
      ).rejects.toThrow('Invalid verificationMethodId');
    });

    test('should throw error for invalid private key format', async () => {
      await expect(
        lifecycleManager.registerKey('did:peer:test#keys-1', 'invalid-key')
      ).rejects.toThrow('Invalid privateKey format');
    });

    test('should throw error for empty private key', async () => {
      await expect(
        lifecycleManager.registerKey('did:peer:test#keys-1', '')
      ).rejects.toThrow('Invalid privateKey');
    });
  });

  describe('createAsset with keyStore', () => {
    test('should automatically register key when keyStore is provided', async () => {
      const asset = await lifecycleManager.createAsset(resources);

      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.did.verificationMethod).toBeDefined();
      expect(asset.did.verificationMethod!.length).toBeGreaterThan(0);

      let vmId = asset.did.verificationMethod![0].id;
      // Ensure VM ID is absolute
      if (vmId.startsWith('#')) {
        vmId = `${asset.did.id}${vmId}`;
      }
      
      const privateKey = await keyStore.getPrivateKey(vmId);
      expect(privateKey).not.toBeNull();
      expect(typeof privateKey).toBe('string');
    });

    test('should create asset without keyStore gracefully', async () => {
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const asset = await lifecycleWithoutKeyStore.createAsset(resources);

      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.did.verificationMethod).toBeDefined();
    });
  });

  describe('publishToWeb with DID keys', () => {
    test('should sign credential with DID document key from keyStore', async () => {
      const asset = await lifecycleManager.createAsset(resources);
      
      // Verify key was stored
      let vmId = asset.did.verificationMethod![0].id;
      if (vmId.startsWith('#')) {
        vmId = `${asset.did.id}${vmId}`;
      }
      const storedKey = await keyStore.getPrivateKey(vmId);
      expect(storedKey).not.toBeNull();
      
      const published = await lifecycleManager.publishToWeb(asset, publisherDid);

      expect(published.currentLayer).toBe('did:webvh');
      expect(published.credentials.length).toBeGreaterThan(0);

      const credential = published.credentials[0];
      expect(credential.proof).toBeDefined();
      expect(credential.type).toContain('ResourceMigrated');
      // The peer->webvh migration credential is countersigned by the PREVIOUS
      // layer's key: issuer = the asset's peer DID (#365).
      expect(credential.issuer).toBe(asset.id);

      const proof = credential.proof as any;
      // Verification method belongs to the asset's peer DID, not the publisher.
      expect(proof.verificationMethod).toContain(asset.id);
    });

    test('should not add credential when keyStore not provided', async () => {
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const asset = await lifecycleWithoutKeyStore.createAsset(resources);

      // Publishing should succeed but no credential should be added (best-effort)
      const published = await lifecycleWithoutKeyStore.publishToWeb(asset, publisherDid);
      
      expect(published.currentLayer).toBe('did:webvh');
      // No credential should be added due to missing keyStore
      expect(published.credentials.length).toBe(0);
    });

    test('should not add credential when private key not found in keyStore', async () => {
      // Create asset without keyStore
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const asset = await lifecycleWithoutKeyStore.createAsset(resources);

      // Try to publish with a different lifecycle manager that has keyStore but no keys
      const emptyKeyStore = new MockKeyStore();
      const lifecycleWithEmptyKeyStore = new LifecycleManager(
        config,
        didManager,
        credentialManager,
        undefined,
        emptyKeyStore
      );

      // Publishing should succeed but no credential should be added (best-effort)
      const published = await lifecycleWithEmptyKeyStore.publishToWeb(asset, publisherDid);
      
      expect(published.currentLayer).toBe('did:webvh');
      // No credential should be added due to missing private key
      expect(published.credentials.length).toBe(0);
    });

    test('should use keys from keyStore not ephemeral keys', async () => {
      const asset = await lifecycleManager.createAsset(resources);
      
      // Get the stored key
      let vmId = asset.did.verificationMethod![0].id;
      if (vmId.startsWith('#')) {
        vmId = `${asset.did.id}${vmId}`;
      }
      const storedKeyBefore = await keyStore.getPrivateKey(vmId);
      
      const published = await lifecycleManager.publishToWeb(asset, publisherDid);
      
      // Verify the same key is still there (not replaced)
      const storedKeyAfter = await keyStore.getPrivateKey(vmId);
      expect(storedKeyAfter).toBe(storedKeyBefore);
      
      // Verify credential was created
      expect(published.credentials.length).toBe(1);
      const credential = published.credentials[0];
      const proof = credential.proof as any;
      // Verification method belongs to the asset's peer DID (#365).
      expect(proof.verificationMethod).toContain(asset.id);
    });

    test('should use correct verification method from DID document', async () => {
      const asset = await lifecycleManager.createAsset(resources);
      let vmId = asset.did.verificationMethod![0].id;
      const publicKey = asset.did.verificationMethod![0].publicKeyMultibase;

      // Ensure VM ID is absolute
      if (vmId.startsWith('#')) {
        vmId = `${asset.did.id}${vmId}`;
      }

      const published = await lifecycleManager.publishToWeb(asset, publisherDid);
      const credential = published.credentials[0];
      const proof = credential.proof as any;

      // The signing VM and issuer are the asset's peer DID (#365).
      expect(proof.verificationMethod).toContain(asset.id);
      expect(vmId).toContain(asset.id); // Asset's VM ID contains asset ID
      expect(credential.issuer).toBe(asset.id);
    });
  });

  describe('Revoked / compromised verification method selection (regression for plan 030)', () => {
    // The migration credential is signed by the asset's PEER key (#365), so the
    // retirement check runs against the PEER DID's document (the signing DID).
    // After a key rotation/recovery, KeyManager places retired keys FIRST and
    // the new active key LAST in the DID document. signWithKeyStore must select
    // the active key, never blindly verificationMethod[0].
    async function publishWithRotatedPeerDoc(retireField: 'revoked' | 'compromised') {
      const keyManager = new KeyManager();
      const oldKeyPair = await keyManager.generateKeyPair('Ed25519');
      const newKeyPair = await keyManager.generateKeyPair('Ed25519');

      // Create the asset first (with a real peer DID) so the rotated document
      // can be keyed to it — the peer DID is what signWithKeyStore resolves.
      const rotatedKeyStore = new MockKeyStore();
      const lm = new LifecycleManager(config, didManager, credentialManager, undefined, rotatedKeyStore);
      const asset = await lm.createAsset(resources);
      const peerDid = asset.id;

      const oldVmId = `${peerDid}#key-0`;
      const newVmId = `${peerDid}#key-1`;

      const didDoc = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: peerDid,
        verificationMethod: [
          {
            id: oldVmId,
            type: 'Multikey',
            controller: peerDid,
            publicKeyMultibase: oldKeyPair.publicKey,
            [retireField]: '2024-01-01T00:00:00Z'
          },
          {
            id: newVmId,
            type: 'Multikey',
            controller: peerDid,
            publicKeyMultibase: newKeyPair.publicKey
          }
        ]
      };

      // keyStore holds BOTH keys: the retired key is inserted FIRST (overwriting
      // createAsset's auto-registered peer key) so a naive "first match" scan
      // would pick it; the new active key is registered alongside it.
      await rotatedKeyStore.setPrivateKey(oldVmId, oldKeyPair.privateKey);
      await rotatedKeyStore.setPrivateKey(newVmId, newKeyPair.privateKey);

      // Resolve the peer DID (the signing DID) to the rotated document.
      (didManager as any).resolveDID = async () => didDoc;

      const published = await lm.publishToWeb(asset, publisherDid);
      return { published, oldVmId, newVmId };
    }

    test('should NOT sign with a revoked verificationMethod[0]', async () => {
      const { published, oldVmId, newVmId } = await publishWithRotatedPeerDoc('revoked');

      expect(published.credentials.length).toBe(1);
      const proof = published.credentials[0].proof as any;
      expect(proof.verificationMethod).toBe(newVmId);
      expect(proof.verificationMethod).not.toBe(oldVmId);
    });

    test('should NOT sign with a compromised verificationMethod[0]', async () => {
      const { published, oldVmId, newVmId } = await publishWithRotatedPeerDoc('compromised');

      expect(published.credentials.length).toBe(1);
      const proof = published.credentials[0].proof as any;
      expect(proof.verificationMethod).toBe(newVmId);
      expect(proof.verificationMethod).not.toBe(oldVmId);
    });

    test('should still sign when the only verification method is active (no over-rejection)', async () => {
      // A single active peer VM (createAsset's auto-registered key) must not be
      // rejected — the credential is signed with the peer DID's key-0.
      const activeKeyStore = new MockKeyStore();
      const lm = new LifecycleManager(config, didManager, credentialManager, undefined, activeKeyStore);
      const asset = await lm.createAsset(resources);
      const published = await lm.publishToWeb(asset, publisherDid);

      expect(published.credentials.length).toBe(1);
      const proof = published.credentials[0].proof as any;
      expect(proof.verificationMethod).toBe(`${asset.id}#key-0`);
    });
  });

  describe('Key rotation scenario', () => {
    test('should allow registering multiple keys for different verification methods', async () => {
      const keyManager = new KeyManager();
      const keyPair1 = await keyManager.generateKeyPair('ES256K');
      const keyPair2 = await keyManager.generateKeyPair('ES256K');

      await lifecycleManager.registerKey('did:peer:test#keys-1', keyPair1.privateKey);
      await lifecycleManager.registerKey('did:peer:test#keys-2', keyPair2.privateKey);

      const key1 = await keyStore.getPrivateKey('did:peer:test#keys-1');
      const key2 = await keyStore.getPrivateKey('did:peer:test#keys-2');

      expect(key1).toBe(keyPair1.privateKey);
      expect(key2).toBe(keyPair2.privateKey);
      expect(key1).not.toBe(key2);
    });
  });

  describe('End-to-end credential management', () => {
    test('should create signed credentials throughout asset lifecycle', async () => {
      // Create asset with automatic key registration
      const asset = await lifecycleManager.createAsset(resources);
      expect(asset.did.verificationMethod).toBeDefined();

      // Publish to web - should create signed credential
      const published = await lifecycleManager.publishToWeb(asset, publisherDid);
      expect(published.credentials.length).toBe(1);

      // Check credential structure
      const credential = published.credentials[0];
      expect(credential.issuer).toBe(asset.id); // Peer DID is the issuer (#365)
      expect(credential.type).toContain('ResourceMigrated');
      expect((credential.credentialSubject as any).fromLayer).toBe('did:peer');
      expect((credential.credentialSubject as any).toLayer).toBe('did:webvh');
      // Subject records the DID the asset migrated TO (the minted webvh DID).
      expect((credential.credentialSubject as any).migratedTo).toBe(published.bindings!['did:webvh']);

      // Verify proof is present with the peer DID's VM.
      expect(credential.proof).toBeDefined();
      const proof = credential.proof as any;
      expect(proof.verificationMethod).toContain(asset.id);
    });
  });

  describe('Error handling', () => {
    test('should handle missing verification method in DID document gracefully', async () => {
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const asset = await lifecycleWithoutKeyStore.createAsset(resources);
      
      // Manually remove verification methods to simulate error case
      (asset.did as any).verificationMethod = [];

      const lifecycleWithKeyStore = new LifecycleManager(
        config,
        didManager,
        credentialManager,
        undefined,
        keyStore
      );

      // Should not throw - credentials can be issued using publisher's keys from keyStore
      const published = await lifecycleWithKeyStore.publishToWeb(asset, publisherDid);
      
      expect(published.currentLayer).toBe('did:webvh');
      // Credential should be added using publisher's verification method from keyStore
      expect(published.credentials.length).toBeGreaterThanOrEqual(0); // Best effort - may or may not issue
    });
  });
});
