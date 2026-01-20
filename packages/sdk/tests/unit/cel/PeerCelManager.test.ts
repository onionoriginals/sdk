import { describe, test, expect, beforeEach } from 'bun:test';
import { PeerCelManager, PeerCelConfig, PeerAssetData, CelSigner } from '../../../src/cel/layers/PeerCelManager';
import type { DataIntegrityProof, EventLog, ExternalReference } from '../../../src/cel/types';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';

/**
 * Mock signer that creates a valid DataIntegrityProof structure.
 * In production, this would use actual Ed25519 signing with eddsa-jcs-2022.
 */
function createMockSigner(verificationMethod?: string): CelSigner {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: verificationMethod || 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + Buffer.from('mock-signature-' + JSON.stringify(data).slice(0, 50)).toString('base64'),
    };
  };
}

describe('PeerCelManager', () => {
  describe('constructor', () => {
    test('creates instance with valid signer', () => {
      const manager = new PeerCelManager(createMockSigner());
      expect(manager).toBeInstanceOf(PeerCelManager);
    });

    test('throws error when signer is not a function', () => {
      expect(() => new PeerCelManager(null as any)).toThrow('PeerCelManager requires a signer function');
      expect(() => new PeerCelManager('not-a-function' as any)).toThrow('PeerCelManager requires a signer function');
    });

    test('accepts optional config', () => {
      const config: PeerCelConfig = {
        verificationMethod: 'did:key:z6Mk123#key-0',
        proofPurpose: 'authentication',
        keyType: 'Ed25519',
      };
      const manager = new PeerCelManager(createMockSigner(), config);
      expect(manager).toBeInstanceOf(PeerCelManager);
    });
  });

  describe('create', () => {
    let manager: PeerCelManager;

    beforeEach(() => {
      manager = new PeerCelManager(createMockSigner());
    });

    test('creates an event log with a single create event', async () => {
      const resources: ExternalReference[] = [
        { digestMultibase: 'uXYZ123abc', mediaType: 'image/png' }
      ];

      const log = await manager.create('My Asset', resources);

      expect(log).toBeDefined();
      expect(log.events).toBeInstanceOf(Array);
      expect(log.events).toHaveLength(1);
    });

    test('create event has type "create"', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);

      expect(log.events[0].type).toBe('create');
    });

    test('create event has no previousEvent (first event in log)', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);

      expect(log.events[0].previousEvent).toBeUndefined();
    });

    test('asset data includes name', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('My Beautiful Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.name).toBe('My Beautiful Asset');
    });

    test('asset data includes did:peer identifier', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.did).toBeDefined();
      expect(data.did.startsWith('did:peer:')).toBe(true);
    });

    test('asset data includes layer as "peer"', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.layer).toBe('peer');
    });

    test('asset data includes provided resources', async () => {
      const resources: ExternalReference[] = [
        { digestMultibase: 'uHash1', mediaType: 'image/png', url: ['https://example.com/1.png'] },
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' },
      ];
      const log = await manager.create('Test Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.resources).toEqual(resources);
    });

    test('asset data includes creator (same as DID for peer layer)', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.creator).toBe(data.did);
    });

    test('asset data includes createdAt timestamp', async () => {
      const beforeCreate = new Date().toISOString();
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const afterCreate = new Date().toISOString();
      const data = log.events[0].data as PeerAssetData;

      expect(data.createdAt).toBeDefined();
      // Verify it's a valid ISO timestamp between before and after
      expect(new Date(data.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeCreate).getTime());
      expect(new Date(data.createdAt).getTime()).toBeLessThanOrEqual(new Date(afterCreate).getTime());
    });

    test('event has at least one proof', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);

      expect(log.events[0].proof).toBeInstanceOf(Array);
      expect(log.events[0].proof.length).toBeGreaterThanOrEqual(1);
    });

    test('proof uses eddsa-jcs-2022 cryptosuite', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const proof = log.events[0].proof[0];

      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    test('proof has type DataIntegrityProof', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);
      const proof = log.events[0].proof[0];

      expect(proof.type).toBe('DataIntegrityProof');
    });

    test('no witness proofs are added (empty for peer layer)', async () => {
      const resources: ExternalReference[] = [];
      const log = await manager.create('Test Asset', resources);

      // Only one proof (controller proof), no witness proofs
      expect(log.events[0].proof).toHaveLength(1);
    });
  });

  describe('input validation', () => {
    let manager: PeerCelManager;

    beforeEach(() => {
      manager = new PeerCelManager(createMockSigner());
    });

    test('throws error when name is empty', async () => {
      const resources: ExternalReference[] = [];
      await expect(manager.create('', resources)).rejects.toThrow('Asset name is required');
    });

    test('throws error when name is not a string', async () => {
      const resources: ExternalReference[] = [];
      await expect(manager.create(123 as any, resources)).rejects.toThrow('Asset name is required');
    });

    test('throws error when resources is not an array', async () => {
      await expect(manager.create('Test', 'not-an-array' as any)).rejects.toThrow('Resources must be an array');
    });

    test('accepts empty resources array', async () => {
      const log = await manager.create('Test Asset', []);
      const data = log.events[0].data as PeerAssetData;

      expect(data.resources).toEqual([]);
    });
  });

  describe('DID generation', () => {
    test('generates unique DIDs for each asset', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [];

      const log1 = await manager.create('Asset 1', resources);
      const log2 = await manager.create('Asset 2', resources);

      const data1 = log1.events[0].data as PeerAssetData;
      const data2 = log2.events[0].data as PeerAssetData;

      expect(data1.did).not.toBe(data2.did);
    });

    test('generates did:peer numalgo 4 (long form) DID', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [];

      const log = await manager.create('Test Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      // Numalgo 4 DIDs start with did:peer:4
      expect(data.did.startsWith('did:peer:4')).toBe(true);
    });
  });

  describe('integration: create then verify cycle', () => {
    test('created log passes verification', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [
        { digestMultibase: 'uTestHash123', mediaType: 'image/png' }
      ];

      const log = await manager.create('My Original', resources);

      // Verify the log
      const result = await verifyEventLog(log);

      // With mock signer, proof structure is valid (but signature is mock)
      // The verifier checks proof structure, not cryptographic validity by default
      expect(result).toBeDefined();
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('create');
      // Chain should be valid (single event with no previousEvent)
      expect(result.events[0].chainValid).toBe(true);
    });

    test('created log has valid EventLog structure', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [];

      const log: EventLog = await manager.create('Test Asset', resources);

      // Verify structure
      expect(log.events).toBeDefined();
      expect(Array.isArray(log.events)).toBe(true);
      expect(log.previousLog).toBeUndefined(); // New log, no previous
    });
  });

  describe('config options', () => {
    test('uses custom verificationMethod from config', async () => {
      const customVm = 'did:key:z6MkCustomKey#key-0';
      const manager = new PeerCelManager(
        createMockSigner(customVm),
        { verificationMethod: customVm }
      );

      const log = await manager.create('Test Asset', []);
      const proof = log.events[0].proof[0];

      expect(proof.verificationMethod).toBe(customVm);
    });

    test('uses custom proofPurpose from config', async () => {
      const customSigner = async (data: unknown): Promise<DataIntegrityProof> => ({
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:key:z6Mk123#key-0',
        proofPurpose: 'authentication',
        proofValue: 'zMockSig',
      });

      const manager = new PeerCelManager(customSigner, {
        proofPurpose: 'authentication',
      });

      const log = await manager.create('Test Asset', []);
      const proof = log.events[0].proof[0];

      expect(proof.proofPurpose).toBe('authentication');
    });
  });

  describe('complex asset scenarios', () => {
    test('handles asset with multiple resources', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [
        { digestMultibase: 'uImageHash', mediaType: 'image/png', url: ['https://cdn.example.com/image.png'] },
        { digestMultibase: 'uVideoHash', mediaType: 'video/mp4', url: ['https://cdn.example.com/video.mp4'] },
        { digestMultibase: 'uAudioHash', mediaType: 'audio/mp3' },
        { digestMultibase: 'uDocHash', mediaType: 'application/pdf' },
      ];

      const log = await manager.create('Multi-Resource Asset', resources);
      const data = log.events[0].data as PeerAssetData;

      expect(data.resources).toHaveLength(4);
      expect(data.resources).toEqual(resources);
    });

    test('handles asset with unicode name', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const unicodeName = 'アート作品 🎨 Œuvre d\'art';

      const log = await manager.create(unicodeName, []);
      const data = log.events[0].data as PeerAssetData;

      expect(data.name).toBe(unicodeName);
    });

    test('handles asset with long name', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const longName = 'A'.repeat(1000);

      const log = await manager.create(longName, []);
      const data = log.events[0].data as PeerAssetData;

      expect(data.name).toBe(longName);
    });
  });
});
