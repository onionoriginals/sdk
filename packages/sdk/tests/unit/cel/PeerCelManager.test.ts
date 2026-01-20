import { describe, test, expect, beforeEach } from 'bun:test';
import { PeerCelManager, PeerCelConfig, PeerAssetData, CelSigner } from '../../../src/cel/layers/PeerCelManager';
import type { DataIntegrityProof, EventLog, ExternalReference, AssetState } from '../../../src/cel/types';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { deactivateEventLog } from '../../../src/cel/algorithms/deactivateEventLog';

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

  describe('update', () => {
    let manager: PeerCelManager;

    beforeEach(() => {
      manager = new PeerCelManager(createMockSigner());
    });

    test('appends an update event to the log', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'Updated Name' });

      expect(updatedLog.events).toHaveLength(2);
      expect(updatedLog.events[1].type).toBe('update');
    });

    test('update event contains provided data', async () => {
      const log = await manager.create('Test Asset', []);
      const updateData = { name: 'New Name', description: 'A description' };
      const updatedLog = await manager.update(log, updateData);

      const eventData = updatedLog.events[1].data as Record<string, unknown>;
      expect(eventData.name).toBe('New Name');
      expect(eventData.description).toBe('A description');
    });

    test('update event includes updatedAt timestamp', async () => {
      const beforeUpdate = new Date().toISOString();
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });
      const afterUpdate = new Date().toISOString();

      const eventData = updatedLog.events[1].data as Record<string, unknown>;
      expect(eventData.updatedAt).toBeDefined();
      const updatedAt = new Date(eventData.updatedAt as string).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(new Date(beforeUpdate).getTime());
      expect(updatedAt).toBeLessThanOrEqual(new Date(afterUpdate).getTime());
    });

    test('update event has previousEvent linking to last event', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      expect(updatedLog.events[1].previousEvent).toBeDefined();
      // previousEvent should be a digestMultibase (starts with 'u')
      expect(updatedLog.events[1].previousEvent!.startsWith('u')).toBe(true);
    });

    test('does not mutate original log', async () => {
      const log = await manager.create('Test Asset', []);
      const originalEventCount = log.events.length;
      
      await manager.update(log, { name: 'New Name' });

      expect(log.events).toHaveLength(originalEventCount);
    });

    test('throws error when updating empty log', async () => {
      const emptyLog: EventLog = { events: [] };
      await expect(manager.update(emptyLog, { name: 'New' })).rejects.toThrow('Cannot update an empty event log');
    });

    test('throws error when updating null/undefined log', async () => {
      await expect(manager.update(null as any, { name: 'New' })).rejects.toThrow('Cannot update an empty event log');
      await expect(manager.update(undefined as any, { name: 'New' })).rejects.toThrow('Cannot update an empty event log');
    });

    test('throws error when updating deactivated log', async () => {
      const log = await manager.create('Test Asset', []);
      const deactivatedLog = await deactivateEventLog(log, 'No longer needed', {
        signer: createMockSigner(),
        verificationMethod: 'did:key:z6Mk#key-0',
        proofPurpose: 'assertionMethod',
      });

      await expect(manager.update(deactivatedLog, { name: 'New' })).rejects.toThrow('Cannot update a deactivated event log');
    });

    test('supports multiple sequential updates', async () => {
      const log = await manager.create('Test Asset', []);
      const log2 = await manager.update(log, { name: 'Name 2' });
      const log3 = await manager.update(log2, { name: 'Name 3' });

      expect(log3.events).toHaveLength(3);
      expect(log3.events[0].type).toBe('create');
      expect(log3.events[1].type).toBe('update');
      expect(log3.events[2].type).toBe('update');

      // Each event should link to the previous
      expect(log3.events[1].previousEvent).toBeDefined();
      expect(log3.events[2].previousEvent).toBeDefined();
      expect(log3.events[1].previousEvent).not.toBe(log3.events[2].previousEvent);
    });

    test('update has valid proof', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const proof = updatedLog.events[1].proof[0];
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
      expect(proof.proofValue).toBeDefined();
    });

    test('handles non-object data by wrapping in value field', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, 'simple string value');

      const eventData = updatedLog.events[1].data as Record<string, unknown>;
      expect(eventData.value).toBe('simple string value');
    });
  });

  describe('getCurrentState', () => {
    let manager: PeerCelManager;

    beforeEach(() => {
      manager = new PeerCelManager(createMockSigner());
    });

    test('returns initial state from create event', async () => {
      const resources: ExternalReference[] = [
        { digestMultibase: 'uHash1', mediaType: 'image/png' }
      ];
      const log = await manager.create('My Asset', resources);

      const state = manager.getCurrentState(log);

      expect(state.name).toBe('My Asset');
      expect(state.layer).toBe('peer');
      expect(state.resources).toEqual(resources);
      expect(state.deactivated).toBe(false);
    });

    test('state has did from create event', async () => {
      const log = await manager.create('Test Asset', []);
      const createData = log.events[0].data as PeerAssetData;

      const state = manager.getCurrentState(log);

      expect(state.did).toBe(createData.did);
      expect(state.did.startsWith('did:peer:')).toBe(true);
    });

    test('state has creator from create event', async () => {
      const log = await manager.create('Test Asset', []);
      const createData = log.events[0].data as PeerAssetData;

      const state = manager.getCurrentState(log);

      expect(state.creator).toBe(createData.creator);
      expect(state.creator).toBe(state.did); // For peer layer, creator === did
    });

    test('state has createdAt from create event', async () => {
      const log = await manager.create('Test Asset', []);
      const createData = log.events[0].data as PeerAssetData;

      const state = manager.getCurrentState(log);

      expect(state.createdAt).toBe(createData.createdAt);
    });

    test('reflects updated name after update event', async () => {
      const log = await manager.create('Original Name', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const state = manager.getCurrentState(updatedLog);

      expect(state.name).toBe('New Name');
    });

    test('reflects updated resources after update event', async () => {
      const initialResources: ExternalReference[] = [
        { digestMultibase: 'uHash1', mediaType: 'image/png' }
      ];
      const log = await manager.create('Test Asset', initialResources);
      
      const newResources: ExternalReference[] = [
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' }
      ];
      const updatedLog = await manager.update(log, { resources: newResources });

      const state = manager.getCurrentState(updatedLog);

      expect(state.resources).toEqual(newResources);
    });

    test('has updatedAt after update event', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const state = manager.getCurrentState(updatedLog);

      expect(state.updatedAt).toBeDefined();
    });

    test('stores custom fields in metadata', async () => {
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { 
        customField: 'custom value',
        anotherField: 123 
      });

      const state = manager.getCurrentState(updatedLog);

      expect(state.metadata).toBeDefined();
      expect(state.metadata?.customField).toBe('custom value');
      expect(state.metadata?.anotherField).toBe(123);
    });

    test('applies multiple updates sequentially', async () => {
      const log = await manager.create('Name 1', []);
      const log2 = await manager.update(log, { name: 'Name 2', version: 1 });
      const log3 = await manager.update(log2, { name: 'Name 3', version: 2 });

      const state = manager.getCurrentState(log3);

      expect(state.name).toBe('Name 3');
      expect(state.metadata?.version).toBe(2);
    });

    test('marks state as deactivated after deactivate event', async () => {
      const log = await manager.create('Test Asset', []);
      const deactivatedLog = await deactivateEventLog(log, 'Asset retired', {
        signer: createMockSigner(),
        verificationMethod: 'did:key:z6Mk#key-0',
        proofPurpose: 'assertionMethod',
      });

      const state = manager.getCurrentState(deactivatedLog);

      expect(state.deactivated).toBe(true);
      expect(state.metadata?.deactivationReason).toBe('Asset retired');
    });

    test('throws error for empty log', () => {
      const emptyLog: EventLog = { events: [] };
      expect(() => manager.getCurrentState(emptyLog)).toThrow('Cannot get state from an empty event log');
    });

    test('throws error for null/undefined log', () => {
      expect(() => manager.getCurrentState(null as any)).toThrow('Cannot get state from an empty event log');
      expect(() => manager.getCurrentState(undefined as any)).toThrow('Cannot get state from an empty event log');
    });

    test('throws error if first event is not create', async () => {
      // Manually construct a log with update as first event
      const invalidLog: EventLog = {
        events: [{
          type: 'update',
          data: { name: 'Invalid' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:key:z6Mk#key-0',
            proofPurpose: 'assertionMethod',
            proofValue: 'zMock',
          }]
        }]
      };

      expect(() => manager.getCurrentState(invalidLog)).toThrow('First event must be a create event');
    });
  });

  describe('integration: create then update then getCurrentState', () => {
    test('full lifecycle shows updated state', async () => {
      const manager = new PeerCelManager(createMockSigner());
      
      // Create asset
      const initialResources: ExternalReference[] = [
        { digestMultibase: 'uOriginalHash', mediaType: 'image/png' }
      ];
      const log = await manager.create('Original Name', initialResources);

      // Verify initial state
      const initialState = manager.getCurrentState(log);
      expect(initialState.name).toBe('Original Name');
      expect(initialState.resources).toEqual(initialResources);
      expect(initialState.deactivated).toBe(false);

      // Update asset
      const newResources: ExternalReference[] = [
        { digestMultibase: 'uNewHash', mediaType: 'video/mp4' }
      ];
      const updatedLog = await manager.update(log, { 
        name: 'Updated Name',
        resources: newResources,
        description: 'Now with video!'
      });

      // Verify updated state
      const updatedState = manager.getCurrentState(updatedLog);
      expect(updatedState.name).toBe('Updated Name');
      expect(updatedState.resources).toEqual(newResources);
      expect(updatedState.metadata?.description).toBe('Now with video!');
      expect(updatedState.deactivated).toBe(false);
      expect(updatedState.updatedAt).toBeDefined();
      
      // Original create data should still be preserved
      expect(updatedState.did).toBe(initialState.did);
      expect(updatedState.creator).toBe(initialState.creator);
      expect(updatedState.createdAt).toBe(initialState.createdAt);
    });

    test('updated log passes verification', async () => {
      const manager = new PeerCelManager(createMockSigner());
      
      const log = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      // Verify the updated log
      const result = await verifyEventLog(updatedLog);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].chainValid).toBe(true);
      expect(result.events[1].chainValid).toBe(true);
    });
  });
});
