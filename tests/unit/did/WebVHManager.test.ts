import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WebVHManager } from '../../../src/did/WebVHManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('WebVHManager', () => {
  let manager: WebVHManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = new WebVHManager();
    // Create a temporary directory for test outputs
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webvh-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe('createDIDWebVH', () => {
    test('creates a valid did:webvh DID with document and log', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      // Verify DID format
      expect(result.did).toMatch(/^did:webvh:example\.com:[a-z0-9]+$/);
      
      // Verify DID document structure
      expect(result.didDocument).toBeDefined();
      expect(result.didDocument.id).toBe(result.did);
      expect(result.didDocument['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(result.didDocument['@context']).toContain('https://w3id.org/security/multikey/v1');
      
      // Verify verification methods
      expect(result.didDocument.verificationMethod).toBeDefined();
      expect(Array.isArray(result.didDocument.verificationMethod)).toBe(true);
      expect(result.didDocument.verificationMethod!.length).toBeGreaterThan(0);
      
      // Verify authentication and assertion methods
      expect(result.didDocument.authentication).toBeDefined();
      expect(result.didDocument.assertionMethod).toBeDefined();
      
      // Verify key pair
      expect(result.keyPair).toBeDefined();
      expect(result.keyPair.publicKey).toMatch(/^z/);
      expect(result.keyPair.privateKey).toMatch(/^z/);
      
      // Verify log
      expect(result.log).toBeDefined();
      expect(Array.isArray(result.log)).toBe(true);
      expect(result.log.length).toBeGreaterThan(0);
      
      // Verify first log entry
      const firstEntry = result.log[0];
      expect(firstEntry.versionId).toBeDefined();
      expect(firstEntry.versionTime).toBeDefined();
      expect(firstEntry.state).toBeDefined();
      expect(firstEntry.proof).toBeDefined();
      
      // Verify log path
      expect(result.logPath).toBeDefined();
      expect(result.logPath).toContain('did.jsonl');
    }, 10000);

    test('creates DID with custom paths', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        paths: ['users', 'alice'],
        outputDir: tempDir,
      });

      expect(result.did).toMatch(/^did:webvh:example\.com:users:alice:[a-z0-9]+$/);
    }, 10000);

    test('creates portable DID when specified', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        portable: true,
        outputDir: tempDir,
      });

      expect(result.didDocument).toBeDefined();
      expect(result.log).toBeDefined();
      // Verify portable flag in log metadata
      const firstEntry = result.log[0];
      expect(firstEntry.parameters).toBeDefined();
    }, 10000);

    test('uses provided key pair when given', async () => {
      // First, generate a key pair
      const keyManager = new (await import('../../../src/did/KeyManager')).KeyManager();
      const customKeyPair = await keyManager.generateKeyPair('Ed25519');

      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        keyPair: customKeyPair,
        outputDir: tempDir,
      });

      // Verify the same key pair is used
      expect(result.keyPair.publicKey).toBe(customKeyPair.publicKey);
      expect(result.keyPair.privateKey).toBe(customKeyPair.privateKey);
    }, 10000);

    test('creates DID without saving log when outputDir is not provided', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
      });

      expect(result.did).toBeDefined();
      expect(result.didDocument).toBeDefined();
      expect(result.log).toBeDefined();
      expect(result.logPath).toBeUndefined();
    }, 10000);
  });

  describe('saveDIDLog', () => {
    test('saves log to correct path for simple DID', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      expect(result.logPath).toBeDefined();
      
      // Verify file exists
      const fileExists = await fs.promises.access(result.logPath!)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      // Verify file content
      const content = await fs.promises.readFile(result.logPath!, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(result.log.length);
      
      // Verify each line is valid JSON
      lines.forEach(line => {
        expect(() => JSON.parse(line)).not.toThrow();
      });
    }, 10000);

    test('saves log to correct path with nested paths', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        paths: ['users', 'alice'],
        outputDir: tempDir,
      });

      expect(result.logPath).toBeDefined();
      expect(result.logPath).toContain(path.join('users', 'alice'));
      
      // Verify file exists
      const fileExists = await fs.promises.access(result.logPath!)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    }, 10000);

    test('creates nested directories as needed', async () => {
      const deepPath = path.join(tempDir, 'deep', 'nested', 'structure');
      
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        paths: ['level1', 'level2'],
        outputDir: deepPath,
      });

      expect(result.logPath).toBeDefined();
      
      // Verify file exists in nested structure
      const fileExists = await fs.promises.access(result.logPath!)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    }, 10000);
  });

  describe('loadDIDLog', () => {
    test('loads saved DID log correctly', async () => {
      // First create and save a DID
      const createResult = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      expect(createResult.logPath).toBeDefined();

      // Load the log
      const loadedLog = await manager.loadDIDLog(createResult.logPath!);

      // Verify loaded log matches original
      expect(loadedLog.length).toBe(createResult.log.length);
      expect(loadedLog[0].versionId).toBe(createResult.log[0].versionId);
      expect(loadedLog[0].versionTime).toBe(createResult.log[0].versionTime);
    }, 10000);
  });

  describe('saveDIDLog error handling', () => {
    test('throws error for invalid DID format (missing parts)', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      await expect(
        manager.saveDIDLog('invalid:did', validLog, tempDir)
      ).rejects.toThrow('Invalid did:webvh format');
    }, 10000);

    test('throws error for non-webvh DID', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      await expect(
        manager.saveDIDLog('did:key:abc123', validLog, tempDir)
      ).rejects.toThrow('Invalid did:webvh format');
    }, 10000);

    test('saves DID without path parts correctly', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      const logPath = await manager.saveDIDLog('did:webvh:example.com', validLog, tempDir);
      
      expect(logPath).toContain('did.jsonl');
      expect(logPath.startsWith(tempDir)).toBe(true);
      
      // Verify file exists
      const fileExists = await fs.promises.access(logPath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    }, 10000);

    test('handles URL-encoded domain correctly', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      const logPath = await manager.saveDIDLog('did:webvh:localhost%3A5000:test', validLog, tempDir);
      
      expect(logPath).toBeDefined();
      expect(logPath.startsWith(tempDir)).toBe(true);
    }, 10000);

    test('rejects empty path segments', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      await expect(
        manager.saveDIDLog('did:webvh:example.com::test', validLog, tempDir)
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('throws error when resolved path escapes base directory', async () => {
      const validLog = [{
        versionId: '1',
        versionTime: new Date().toISOString(),
        parameters: {},
        state: {}
      }];

      // This should be caught by the validation, but testing defense in depth
      // Create a mock DID that would try to escape (though validation prevents it)
      await expect(
        manager.saveDIDLog('did:webvh:example.com:..', validLog, tempDir)
      ).rejects.toThrow();
    }, 10000);
  });

  describe('security: path traversal prevention', () => {
    test('rejects DIDs with ".." in path segments', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['..', 'etc', 'passwd'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with "." in path segments', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['.', 'secret'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with path separators in segments', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['users/../../etc', 'passwd'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with backslashes in path segments', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['users\\..\\..\\etc', 'passwd'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with null bytes in path segments', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['users\0etc', 'passwd'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with absolute paths (Unix)', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['/etc/passwd'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('rejects DIDs with absolute paths (Windows)', async () => {
      await expect(
        manager.createDIDWebVH({
          domain: 'example.com',
          paths: ['C:\\Windows\\System32'],
          outputDir: tempDir,
        })
      ).rejects.toThrow('Invalid path segment in DID');
    }, 10000);

    test('accepts valid alphanumeric path segments', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        paths: ['users', 'alice123', 'profile'],
        outputDir: tempDir,
      });

      expect(result.did).toBeDefined();
      expect(result.logPath).toBeDefined();
      
      // Verify file was created in the correct location
      const fileExists = await fs.promises.access(result.logPath!)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
      
      // Verify path is within temp directory
      expect(result.logPath!.startsWith(tempDir)).toBe(true);
    }, 10000);

    test('accepts valid path segments with hyphens and underscores', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        paths: ['my-org', 'user_name', 'test-123'],
        outputDir: tempDir,
      });

      expect(result.did).toBeDefined();
      expect(result.logPath).toBeDefined();
      expect(result.logPath!.startsWith(tempDir)).toBe(true);
    }, 10000);
  });

  describe('integration with didwebvh-ts', () => {
    test('creates cryptographically valid DID with proper proofs', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      // Verify proof exists and has required fields
      const firstEntry = result.log[0];
      expect(firstEntry.proof).toBeDefined();
      expect(Array.isArray(firstEntry.proof)).toBe(true);
      expect(firstEntry.proof!.length).toBeGreaterThan(0);
      
      const proof = firstEntry.proof![0];
      expect(proof.type).toBeDefined();
      expect(proof.cryptosuite).toBeDefined();
      expect(proof.verificationMethod).toBeDefined();
      expect(proof.created).toBeDefined();
      expect(proof.proofValue).toBeDefined();
      expect(proof.proofPurpose).toBeDefined();
    }, 10000);

    test('creates DID with proper SCID', async () => {
      const result = await manager.createDIDWebVH({
        domain: 'example.com',
        outputDir: tempDir,
      });

      const firstEntry = result.log[0];
      expect(firstEntry.parameters).toBeDefined();
      expect(firstEntry.parameters.scid).toBeDefined();
      expect(typeof firstEntry.parameters.scid).toBe('string');
    }, 10000);
  });
});
