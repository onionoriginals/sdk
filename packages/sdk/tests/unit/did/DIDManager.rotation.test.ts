import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DIDManager } from '../../../src/did/DIDManager';
import { KeyManager } from '../../../src/did/KeyManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DIDManager - Key Rotation', () => {
  let didManager: DIDManager;
  let keyManager: KeyManager;
  let tempDir: string;

  beforeEach(async () => {
    didManager = new DIDManager({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      webvhNetwork: 'magby',
    });
    keyManager = new KeyManager();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'didmgr-rotation-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('rotateDIDWebVHKeys', () => {
    test('rotates keys and creates a new version history entry', async () => {
      // Create a did:webvh via DIDManager
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const rotateResult = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      // Verify the rotation produced a new log entry
      expect(rotateResult.log.length).toBe(createResult.log.length + 1);

      // Verify the DID identity is preserved
      expect(rotateResult.didDocument.id).toBe(createResult.did);

      // Verify a new key pair was generated
      expect(rotateResult.newKeyPair.publicKey).not.toBe(createResult.keyPair.publicKey);
      expect(rotateResult.newKeyPair.publicKey).toMatch(/^z/);

      // Verify log was saved
      expect(rotateResult.logPath).toBeDefined();
    }, 15000);

    test('accepts a custom new key pair', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      const customKeyPair = await keyManager.generateKeyPair('Ed25519');

      const rotateResult = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
        newKeyPair: customKeyPair,
      });

      expect(rotateResult.newKeyPair.publicKey).toBe(customKeyPair.publicKey);
    }, 15000);

    test('subsequent rotation uses new key to sign', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      // First rotation
      const first = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      // Second rotation using the new key from first rotation
      const second = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: first.log,
        currentKeyPair: first.newKeyPair,
      });

      // 3 entries: create + 2 rotations
      expect(second.log.length).toBe(3);

      // All keys should be different
      const keys = [
        createResult.keyPair.publicKey,
        first.newKeyPair.publicKey,
        second.newKeyPair.publicKey,
      ];
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(3);
    }, 20000);

    test('each rotation entry has cryptographic proof', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      const rotateResult = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: createResult.log,
        currentKeyPair: createResult.keyPair,
      });

      // Verify every entry has a proof
      for (const entry of rotateResult.log) {
        expect(entry.proof).toBeDefined();
        expect(Array.isArray(entry.proof)).toBe(true);
        expect(entry.proof!.length).toBeGreaterThan(0);
        expect(entry.proof![0].proofValue).toBeDefined();
        expect(entry.proof![0].verificationMethod).toBeDefined();
      }
    }, 15000);
  });
});

describe('DIDManager - Key Recovery', () => {
  let didManager: DIDManager;
  let keyManager: KeyManager;
  let tempDir: string;

  beforeEach(async () => {
    didManager = new DIDManager({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      webvhNetwork: 'magby',
    });
    keyManager = new KeyManager();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'didmgr-recovery-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('recoverDIDWebVH', () => {
    test('recovers from compromise with recovery credential', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const recoveryResult = await didManager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
        outputDir: tempDir,
      });

      // Verify log entry added
      expect(recoveryResult.log.length).toBe(createResult.log.length + 1);

      // Verify recovery credential
      expect(recoveryResult.recoveryCredential).toBeDefined();
      expect(recoveryResult.recoveryCredential.type).toContain('VerifiableCredential');
      expect(recoveryResult.recoveryCredential.type).toContain('KeyRecoveryCredential');
      expect(recoveryResult.recoveryCredential.credentialSubject.recoveryReason).toBe('key_compromise');

      // Verify new key pair
      expect(recoveryResult.newKeyPair.publicKey).not.toBe(createResult.keyPair.publicKey);

      // Verify DID identity preserved
      expect(recoveryResult.didDocument.id).toBe(createResult.did);

      // Verify log saved
      expect(recoveryResult.logPath).toBeDefined();
    }, 15000);

    test('uses custom recovery key pair when provided', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryKeyPair = await keyManager.generateKeyPair('Ed25519');

      const recoveryResult = await didManager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
        recoveryKeyPair,
      });

      expect(recoveryResult.newKeyPair.publicKey).toBe(recoveryKeyPair.publicKey);
    }, 15000);

    test('can rotate keys after recovery', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      // Recover
      const recoveryResult = await didManager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      // Rotate with recovered key
      const rotateResult = await didManager.rotateDIDWebVHKeys({
        did: createResult.did,
        currentLog: recoveryResult.log,
        currentKeyPair: recoveryResult.newKeyPair,
      });

      expect(rotateResult.log.length).toBe(3); // create + recovery + rotation
      expect(rotateResult.didDocument.id).toBe(createResult.did);
    }, 20000);

    test('recovery credential has proper W3C VC structure', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryResult = await didManager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      const cred = recoveryResult.recoveryCredential;
      expect(cred['@context']).toContain('https://www.w3.org/2018/credentials/v1');
      expect(cred.issuer).toBeDefined();
      expect(cred.issuanceDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(cred.credentialSubject.previousVerificationMethods).toBeDefined();
      expect(Array.isArray(cred.credentialSubject.previousVerificationMethods)).toBe(true);
      expect(cred.credentialSubject.newVerificationMethod).toBeDefined();
    }, 15000);

    test('recovery proof has valid structure', async () => {
      const createResult = await didManager.createDIDWebVH({
        domain: 'example.com',
      });

      const recoveryResult = await didManager.recoverDIDWebVH({
        did: createResult.did,
        currentLog: createResult.log,
        signingKeyPair: createResult.keyPair,
      });

      const lastEntry = recoveryResult.log[recoveryResult.log.length - 1];
      expect(lastEntry.proof).toBeDefined();
      expect(lastEntry.proof![0].proofValue).toBeDefined();
      expect(lastEntry.proof![0].created).toBeDefined();
    }, 15000);
  });
});
