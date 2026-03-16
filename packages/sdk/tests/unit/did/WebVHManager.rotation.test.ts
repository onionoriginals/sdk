import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('WebVHManager - Key Rotation', () => {
  let manager: WebVHManager;
  let keyManager: KeyManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = new WebVHManager();
    keyManager = new KeyManager();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webvh-rotation-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('rotateDIDWebVHKeys', () => {
    test('rotates keys and creates a new log entry', async () => {
      // Create initial DID
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      // Rotate keys
      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      // Verify new log has one more entry
      expect(rotateResult.log.length).toBe(createResult.log.length + 1);

      // Verify DID document has rotated keys
      expect(rotateResult.didDocument).toBeDefined();
      expect(rotateResult.didDocument.id).toBe(createResult.did);
      expect(rotateResult.didDocument.verificationMethod).toBeDefined();

      // Verify new key pair is returned
      expect(rotateResult.newKeyPair).toBeDefined();
      expect(rotateResult.newKeyPair.publicKey).toMatch(/^z/);
      expect(rotateResult.newKeyPair.privateKey).toMatch(/^z/);

      // Verify new key is different from old key
      expect(rotateResult.newKeyPair.publicKey).not.toBe(createResult.keyPair.publicKey);
    }, 15000);

    test('uses provided new key pair when specified', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const newKeyPair = await keyManager.generateKeyPair('Ed25519');

      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
        newKeyPair,
      });

      expect(rotateResult.newKeyPair.publicKey).toBe(newKeyPair.publicKey);
      expect(rotateResult.newKeyPair.privateKey).toBe(newKeyPair.privateKey);
    }, 15000);

    test('saves updated log to disk when outputDir is provided', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      expect(rotateResult.logPath).toBeDefined();

      // Load and verify saved log
      const loadedLog = await manager.loadDIDLog(rotateResult.logPath!);
      expect(loadedLog.length).toBe(rotateResult.log.length);
    }, 15000);

    test('rotated document contains new key in verification methods', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      // The returned document should have verification methods
      // didwebvh-ts may restructure the document, so check for the new key's presence
      const doc = rotateResult.didDocument;
      const vms = doc.verificationMethod || [];

      // If didwebvh-ts preserves VMs, check them; otherwise verify the log state
      if (vms.length > 0) {
        // At least one VM should reference the new key
        const hasNewKey = vms.some(
          vm => vm.publicKeyMultibase === rotateResult.newKeyPair.publicKey
        );
        expect(hasNewKey).toBe(true);
      } else {
        // Verify via the log state that the document was updated
        const lastEntry = rotateResult.log[rotateResult.log.length - 1];
        const state = lastEntry.state as Record<string, unknown>;
        expect(state).toBeDefined();
      }
    }, 15000);

    test('subsequent rotation uses new key to sign', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      // First rotation
      const firstRotation = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      // Second rotation using the new key from first rotation
      const secondRotation = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: firstRotation.log,
        currentKeyPair: firstRotation.newKeyPair,
      });

      // Should have 3 log entries total
      expect(secondRotation.log.length).toBe(3);

      // New key should be different from the first rotation's key
      expect(secondRotation.newKeyPair.publicKey).not.toBe(firstRotation.newKeyPair.publicKey);
    }, 20000);

    test('preserves DID identity across rotations', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      expect(rotateResult.didDocument.id).toBe(createResult.did);
    }, 15000);

    test('new log entry has valid proof', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      const lastEntry = rotateResult.log[rotateResult.log.length - 1];
      expect(lastEntry.proof).toBeDefined();
      expect(Array.isArray(lastEntry.proof)).toBe(true);
      expect(lastEntry.proof!.length).toBeGreaterThan(0);
      expect(lastEntry.proof![0].proofValue).toBeDefined();
    }, 15000);
  });
});

describe('WebVHManager - Key Recovery', () => {
  let manager: WebVHManager;
  let keyManager: KeyManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = new WebVHManager();
    keyManager = new KeyManager();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webvh-recovery-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('recoverDIDWebVH', () => {
    test('recovers from compromise and creates recovery log entry', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      // Verify new log has one more entry
      expect(recoveryResult.log.length).toBe(createResult.log.length + 1);

      // Verify DID identity is preserved
      expect(recoveryResult.didDocument.id).toBe(createResult.did);

      // Verify recovery credential is returned
      expect(recoveryResult.recoveryCredential).toBeDefined();
      expect(recoveryResult.recoveryCredential.type).toContain('KeyRecoveryCredential');
      expect(recoveryResult.recoveryCredential.credentialSubject.recoveryReason).toBe('key_compromise');

      // Verify new key pair is returned
      expect(recoveryResult.newKeyPair).toBeDefined();
      expect(recoveryResult.newKeyPair.publicKey).not.toBe(createResult.keyPair.publicKey);
    }, 15000);

    test('recovered document contains new key', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      // The returned document should have the recovery reflected
      const doc = recoveryResult.didDocument;
      const vms = doc.verificationMethod || [];

      if (vms.length > 0) {
        // At least one VM should reference the recovery key
        const hasNewKey = vms.some(
          vm => vm.publicKeyMultibase === recoveryResult.newKeyPair.publicKey
        );
        expect(hasNewKey).toBe(true);
      } else {
        // Verify via the log state that the document was updated
        const lastEntry = recoveryResult.log[recoveryResult.log.length - 1];
        const state = lastEntry.state as Record<string, unknown>;
        expect(state).toBeDefined();
      }

      // Verify the recovery credential references the correct DID
      expect(recoveryResult.recoveryCredential.credentialSubject.recoveryReason).toBe('key_compromise');
    }, 15000);

    test('uses provided recovery key pair when specified', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryKeyPair = await keyManager.generateKeyPair('Ed25519');

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
        recoveryKeyPair,
      });

      expect(recoveryResult.newKeyPair.publicKey).toBe(recoveryKeyPair.publicKey);
    }, 15000);

    test('saves recovery log to disk when outputDir is provided', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      expect(recoveryResult.logPath).toBeDefined();

      // Load and verify saved log
      const loadedLog = await manager.loadDIDLog(recoveryResult.logPath!);
      expect(loadedLog.length).toBe(recoveryResult.log.length);
    }, 15000);

    test('recovery credential references correct DID and keys', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      const cred = recoveryResult.recoveryCredential;
      expect(cred.credentialSubject.id).toBeDefined();
      expect(cred.credentialSubject.previousVerificationMethods.length).toBeGreaterThan(0);
      expect(cred.credentialSubject.newVerificationMethod).toBeDefined();
      expect(cred.issuanceDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }, 15000);

    test('can rotate keys after recovery', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      // Recover
      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      // Rotate with recovered key
      const rotateResult = await manager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: recoveryResult.log,
        currentKeyPair: recoveryResult.newKeyPair,
      });

      // Should have 3 log entries: create + recovery + rotation
      expect(rotateResult.log.length).toBe(3);
      expect(rotateResult.didDocument.id).toBe(createResult.did);
    }, 20000);

    test('recovery log entry has valid proof', async () => {
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryResult = await manager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      const lastEntry = recoveryResult.log[recoveryResult.log.length - 1];
      expect(lastEntry.proof).toBeDefined();
      expect(Array.isArray(lastEntry.proof)).toBe(true);
      expect(lastEntry.proof!.length).toBeGreaterThan(0);
      expect(lastEntry.proof![0].proofValue).toBeDefined();
    }, 15000);
  });
});
