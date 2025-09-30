import { expect, describe, test, beforeEach } from '@jest/globals';
import { LifecycleManager } from '../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../src/did/DIDManager';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { KeyManager } from '../../src/did/KeyManager';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { OriginalsConfig } from '../../src/types';

const resources = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'deadbeef'
  }
];

const config: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'ES256K',
  enableLogging: true
};

describe('LifecycleManager Key Management', () => {
  let lifecycleManager: LifecycleManager;
  let didManager: DIDManager;
  let credentialManager: CredentialManager;
  let keyStore: MockKeyStore;

  beforeEach(() => {
    didManager = new DIDManager(config);
    credentialManager = new CredentialManager(config, didManager);
    keyStore = new MockKeyStore();
    lifecycleManager = new LifecycleManager(config, didManager, credentialManager, undefined, keyStore);
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
      
      const published = await lifecycleManager.publishToWeb(asset, 'example.com');

      expect(published.currentLayer).toBe('did:webvh');
      expect(published.credentials.length).toBeGreaterThan(0);

      const credential = published.credentials[0];
      expect(credential.proof).toBeDefined();
      expect(credential.type).toContain('ResourceMigrated');
      expect(credential.issuer).toBe(asset.id);
      
      const proof = credential.proof as any;
      expect(proof.verificationMethod).toBe(vmId);
    });

    test('should not add credential when keyStore not provided', async () => {
      const lifecycleWithoutKeyStore = new LifecycleManager(config, didManager, credentialManager);
      const asset = await lifecycleWithoutKeyStore.createAsset(resources);

      // Publishing should succeed but no credential should be added (best-effort)
      const published = await lifecycleWithoutKeyStore.publishToWeb(asset, 'example.com');
      
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
      const published = await lifecycleWithEmptyKeyStore.publishToWeb(asset, 'example.com');
      
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
      
      const published = await lifecycleManager.publishToWeb(asset, 'example.com');
      
      // Verify the same key is still there (not replaced)
      const storedKeyAfter = await keyStore.getPrivateKey(vmId);
      expect(storedKeyAfter).toBe(storedKeyBefore);
      
      // Verify credential was created
      expect(published.credentials.length).toBe(1);
      const credential = published.credentials[0];
      const proof = credential.proof as any;
      expect(proof.verificationMethod).toBe(vmId);
    });

    test('should use correct verification method from DID document', async () => {
      const asset = await lifecycleManager.createAsset(resources);
      let vmId = asset.did.verificationMethod![0].id;
      const publicKey = asset.did.verificationMethod![0].publicKeyMultibase;

      // Ensure VM ID is absolute
      if (vmId.startsWith('#')) {
        vmId = `${asset.did.id}${vmId}`;
      }

      const published = await lifecycleManager.publishToWeb(asset, 'example.com');
      const credential = published.credentials[0];
      const proof = credential.proof as any;

      // Verify the VM ID matches and references the DID document
      expect(proof.verificationMethod).toBe(vmId);
      expect(vmId).toContain(asset.id);
      expect(credential.issuer).toBe(asset.id);
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
      const published = await lifecycleManager.publishToWeb(asset, 'example.com');
      expect(published.credentials.length).toBe(1);

      // Check credential structure
      const credential = published.credentials[0];
      expect(credential.issuer).toBe(asset.id);
      expect(credential.type).toContain('ResourceMigrated');
      expect((credential.credentialSubject as any).fromLayer).toBe('did:peer');
      expect((credential.credentialSubject as any).toLayer).toBe('did:webvh');
      
      // Verify proof is present with correct VM
      expect(credential.proof).toBeDefined();
      const proof = credential.proof as any;
      let vmId = asset.did.verificationMethod![0].id;
      if (vmId.startsWith('#')) {
        vmId = `${asset.id}${vmId}`;
      }
      expect(proof.verificationMethod).toBe(vmId);
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

      // Should not throw - best effort, continues without credential
      const published = await lifecycleWithKeyStore.publishToWeb(asset, 'example.com');
      
      expect(published.currentLayer).toBe('did:webvh');
      // No credential should be added due to missing verification method
      expect(published.credentials.length).toBe(0);
    });
  });
});
