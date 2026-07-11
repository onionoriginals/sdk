import { describe, test, expect, beforeEach } from 'bun:test';
import { PeerCelManager, PeerCelConfig, CelAssetData, CelSigner } from '../../../src/cel/layers/PeerCelManager';
import type { DataIntegrityProof, EventLog, ExternalReference, AssetState } from '../../../src/cel/types';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { deactivateEventLog } from '../../../src/cel/algorithms/deactivateEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';

// The did:key the default mock signer reports as its verificationMethod; the
// controller derived from the create event equals the DID portion (before '#').
const MOCK_CONTROLLER = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

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
      verificationMethod: verificationMethod || `${MOCK_CONTROLLER}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`,
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

    test('returns a derived did:cel and a de-self-referenced genesis', async () => {
      const { log, did } = await manager.create('My Asset', []);
      expect(did.startsWith('did:cel:u')).toBe(true);
      expect(deriveDidCel(log)).toBe(did);
      const data = log.events[0].data as Record<string, unknown>;
      expect(data.did).toBeUndefined();          // no self-reference
      expect(data.creator).toBeUndefined();      // holder ≠ asset identity
      expect(data.layer).toBeUndefined();        // genesis layer is definitional
      expect(typeof data.controller).toBe('string');
      expect((data.controller as string).startsWith('did:key:')).toBe(true);
      expect(typeof data.nonce).toBe('string');
    });

    test('two identical creates yield different DIDs (nonce)', async () => {
      const a = await manager.create('Same', []);
      const b = await manager.create('Same', []);
      expect(a.did).not.toBe(b.did);
    });

    test('creates an event log with a single create event', async () => {
      const resources: ExternalReference[] = [
        { digestMultibase: 'uXYZ123abc', mediaType: 'image/png' }
      ];

      const { log } = await manager.create('My Asset', resources);

      expect(log).toBeDefined();
      expect(log.events).toBeInstanceOf(Array);
      expect(log.events).toHaveLength(1);
    });

    test('create event has type "create"', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);

      expect(log.events[0].type).toBe('create');
    });

    test('create event has no previousEvent (first event in log)', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);

      expect(log.events[0].previousEvent).toBeUndefined();
    });

    test('asset data includes name', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('My Beautiful Asset', resources);
      const data = log.events[0].data as CelAssetData;

      expect(data.name).toBe('My Beautiful Asset');
    });

    test('asset data includes controller (the holder did:key)', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);
      const data = log.events[0].data as CelAssetData;

      expect(data.controller).toBe(MOCK_CONTROLLER);
    });

    test('asset data includes provided resources', async () => {
      const resources: ExternalReference[] = [
        { digestMultibase: 'uHash1', mediaType: 'image/png', url: ['https://example.com/1.png'] },
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' },
      ];
      const { log } = await manager.create('Test Asset', resources);
      const data = log.events[0].data as CelAssetData;

      expect(data.resources).toEqual(resources);
    });

    test('asset data includes a nonce (multibase base64url, 16 bytes)', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);
      const data = log.events[0].data as CelAssetData;

      expect(typeof data.nonce).toBe('string');
      expect(data.nonce.startsWith('u')).toBe(true);
    });

    test('asset data includes createdAt timestamp', async () => {
      const beforeCreate = new Date().toISOString();
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);
      const afterCreate = new Date().toISOString();
      const data = log.events[0].data as CelAssetData;

      expect(data.createdAt).toBeDefined();
      // Verify it's a valid ISO timestamp between before and after
      expect(new Date(data.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeCreate).getTime());
      expect(new Date(data.createdAt).getTime()).toBeLessThanOrEqual(new Date(afterCreate).getTime());
    });

    test('event has at least one proof', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);

      expect(log.events[0].proof).toBeInstanceOf(Array);
      expect(log.events[0].proof.length).toBeGreaterThanOrEqual(1);
    });

    test('proof uses eddsa-jcs-2022 cryptosuite', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);
      const proof = log.events[0].proof[0];

      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    test('proof has type DataIntegrityProof', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);
      const proof = log.events[0].proof[0];

      expect(proof.type).toBe('DataIntegrityProof');
    });

    test('no witness proofs are added (empty for peer layer)', async () => {
      const resources: ExternalReference[] = [];
      const { log } = await manager.create('Test Asset', resources);

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
      const { log } = await manager.create('Test Asset', []);
      const data = log.events[0].data as CelAssetData;

      expect(data.resources).toEqual([]);
    });
  });

  describe('DID derivation', () => {
    test('derives a distinct did:cel for each asset (nonce insurance)', async () => {
      const manager = new PeerCelManager(createMockSigner());

      const a = await manager.create('Asset 1', []);
      const b = await manager.create('Asset 2', []);

      expect(a.did).not.toBe(b.did);
    });

    test('derives a did:cel identifier', async () => {
      const manager = new PeerCelManager(createMockSigner());

      const { did } = await manager.create('Test Asset', []);

      expect(did.startsWith('did:cel:')).toBe(true);
    });
  });

  describe('integration: create then verify cycle', () => {
    test('created log passes verification', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const resources: ExternalReference[] = [
        { digestMultibase: 'uTestHash123', mediaType: 'image/png' }
      ];

      const { log } = await manager.create('My Original', resources);

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

      const { log } = await manager.create('Test Asset', resources);

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

      const { log } = await manager.create('Test Asset', []);
      const proof = log.events[0].proof[0];

      expect(proof.verificationMethod).toBe(customVm);
    });

    test('controller from config verificationMethod is the DID before the fragment', async () => {
      const customVm = 'did:key:z6MkCustomKey#key-0';
      const manager = new PeerCelManager(
        createMockSigner(customVm),
        { verificationMethod: customVm }
      );

      const { log } = await manager.create('Test Asset', []);
      const data = log.events[0].data as CelAssetData;

      expect(data.controller).toBe('did:key:z6MkCustomKey');
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

      const { log } = await manager.create('Test Asset', []);
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

      const { log } = await manager.create('Multi-Resource Asset', resources);
      const data = log.events[0].data as CelAssetData;

      expect(data.resources).toHaveLength(4);
      expect(data.resources).toEqual(resources);
    });

    test('handles asset with unicode name', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const unicodeName = 'アート作品 🎨 Œuvre d\'art';

      const { log } = await manager.create(unicodeName, []);
      const data = log.events[0].data as CelAssetData;

      expect(data.name).toBe(unicodeName);
    });

    test('handles asset with long name', async () => {
      const manager = new PeerCelManager(createMockSigner());
      const longName = 'A'.repeat(1000);

      const { log } = await manager.create(longName, []);
      const data = log.events[0].data as CelAssetData;

      expect(data.name).toBe(longName);
    });
  });

  describe('update', () => {
    let manager: PeerCelManager;

    beforeEach(() => {
      manager = new PeerCelManager(createMockSigner());
    });

    test('appends an update event to the log', async () => {
      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'Updated Name' });

      expect(updatedLog.events).toHaveLength(2);
      expect(updatedLog.events[1].type).toBe('update');
    });

    test('update event contains provided data', async () => {
      const { log } = await manager.create('Test Asset', []);
      const updateData = { name: 'New Name', description: 'A description' };
      const updatedLog = await manager.update(log, updateData);

      const eventData = updatedLog.events[1].data as Record<string, unknown>;
      expect(eventData.name).toBe('New Name');
      expect(eventData.description).toBe('A description');
    });

    test('update event includes updatedAt timestamp', async () => {
      const beforeUpdate = new Date().toISOString();
      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });
      const afterUpdate = new Date().toISOString();

      const eventData = updatedLog.events[1].data as Record<string, unknown>;
      expect(eventData.updatedAt).toBeDefined();
      const updatedAt = new Date(eventData.updatedAt as string).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(new Date(beforeUpdate).getTime());
      expect(updatedAt).toBeLessThanOrEqual(new Date(afterUpdate).getTime());
    });

    test('update event has previousEvent linking to last event', async () => {
      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      expect(updatedLog.events[1].previousEvent).toBeDefined();
      // previousEvent should be a digestMultibase (starts with 'u')
      expect(updatedLog.events[1].previousEvent!.startsWith('u')).toBe(true);
    });

    test('does not mutate original log', async () => {
      const { log } = await manager.create('Test Asset', []);
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
      const { log } = await manager.create('Test Asset', []);
      const deactivatedLog = await deactivateEventLog(log, 'No longer needed', {
        signer: createMockSigner(),
        verificationMethod: 'did:key:z6Mk#key-0',
        proofPurpose: 'assertionMethod',
      });

      await expect(manager.update(deactivatedLog, { name: 'New' })).rejects.toThrow('Cannot update a deactivated event log');
    });

    test('supports multiple sequential updates', async () => {
      const { log } = await manager.create('Test Asset', []);
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
      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const proof = updatedLog.events[1].proof[0];
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
      expect(proof.proofValue).toBeDefined();
    });

    test('handles non-object data by wrapping in value field', async () => {
      const { log } = await manager.create('Test Asset', []);
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
      const { log } = await manager.create('My Asset', resources);

      const state = manager.getCurrentState(log);

      expect(state.name).toBe('My Asset');
      expect(state.layer).toBe('peer');
      expect(state.resources).toEqual(resources);
      expect(state.deactivated).toBe(false);
    });

    test('state did is the derived did:cel from the create event', async () => {
      const { log, did } = await manager.create('Test Asset', []);

      const state = manager.getCurrentState(log);

      expect(state.did).toBe(did);
      expect(state.did.startsWith('did:cel:')).toBe(true);
    });

    test('state creator is the controller from the create event', async () => {
      const { log } = await manager.create('Test Asset', []);
      const createData = log.events[0].data as CelAssetData;

      const state = manager.getCurrentState(log);

      expect(state.creator).toBe(createData.controller);
      expect(state.creator).toBe(MOCK_CONTROLLER);
    });

    test('state controller is the genesis controller before any rotation', async () => {
      const { log } = await manager.create('Test Asset', []);

      const state = manager.getCurrentState(log);

      expect(state.controller).toBe(MOCK_CONTROLLER);
    });

    test('rotateKey replay hands the controller off to the last newController', async () => {
      const { log } = await manager.create('Test Asset', []);
      const rotatedLog: EventLog = {
        events: [
          ...log.events,
          {
            type: 'rotateKey',
            data: { newController: 'did:key:z6MkFirstRotation', rotatedAt: '2026-01-01T00:00:00.000Z' },
            previousEvent: 'uRotate1',
            proof: log.events[0].proof,
          },
          {
            type: 'rotateKey',
            data: { newController: 'did:key:z6MkSecondRotation', rotatedAt: '2026-02-01T00:00:00.000Z' },
            previousEvent: 'uRotate2',
            proof: log.events[0].proof,
          },
        ],
      };

      const state = manager.getCurrentState(rotatedLog);

      expect(state.controller).toBe('did:key:z6MkSecondRotation');
    });

    test('transfer replay records owners in metadata and bumps updatedAt', async () => {
      const { log } = await manager.create('Test Asset', []);
      const transferredLog: EventLog = {
        events: [
          ...log.events,
          {
            type: 'transfer',
            data: {
              previousOwner: MOCK_CONTROLLER,
              newOwner: 'bc1qnewowner',
              transferredAt: '2026-03-01T00:00:00.000Z',
              txid: 'cafebabe',
            },
            previousEvent: 'uTransfer',
            proof: log.events[0].proof,
          },
        ],
      };

      const state = manager.getCurrentState(transferredLog);

      expect(state.metadata?.previousOwner).toBe(MOCK_CONTROLLER);
      expect(state.metadata?.newOwner).toBe('bc1qnewowner');
      expect(state.metadata?.txid).toBe('cafebabe');
      expect(state.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    });

    test('first-class migrate replay updates layer, did, and migration metadata', async () => {
      const { log, did } = await manager.create('Test Asset', []);
      const migratedLog: EventLog = {
        events: [
          ...log.events,
          {
            type: 'migrate',
            data: {
              sourceDid: did,
              targetDid: 'did:webvh:example.com:abc123',
              layer: 'webvh',
              domain: 'example.com',
              migratedAt: '2026-04-01T00:00:00.000Z',
            },
            previousEvent: 'uMigrate',
            proof: log.events[0].proof,
          },
        ],
      };

      const state = manager.getCurrentState(migratedLog);

      expect(state.layer).toBe('webvh');
      expect(state.did).toBe('did:webvh:example.com:abc123');
      expect(state.metadata?.sourceDid).toBe(did);
      expect(state.metadata?.domain).toBe('example.com');
      expect(state.updatedAt).toBe('2026-04-01T00:00:00.000Z');
    });

    test('state has createdAt from create event', async () => {
      const { log } = await manager.create('Test Asset', []);
      const createData = log.events[0].data as CelAssetData;

      const state = manager.getCurrentState(log);

      expect(state.createdAt).toBe(createData.createdAt);
    });

    test('reflects updated name after update event', async () => {
      const { log } = await manager.create('Original Name', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const state = manager.getCurrentState(updatedLog);

      expect(state.name).toBe('New Name');
    });

    test('reflects updated resources after update event', async () => {
      const initialResources: ExternalReference[] = [
        { digestMultibase: 'uHash1', mediaType: 'image/png' }
      ];
      const { log } = await manager.create('Test Asset', initialResources);

      const newResources: ExternalReference[] = [
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' }
      ];
      const updatedLog = await manager.update(log, { resources: newResources });

      const state = manager.getCurrentState(updatedLog);

      expect(state.resources).toEqual(newResources);
    });

    test('has updatedAt after update event', async () => {
      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      const state = manager.getCurrentState(updatedLog);

      expect(state.updatedAt).toBeDefined();
    });

    test('stores custom fields in metadata', async () => {
      const { log } = await manager.create('Test Asset', []);
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
      const { log } = await manager.create('Name 1', []);
      const log2 = await manager.update(log, { name: 'Name 2', version: 1 });
      const log3 = await manager.update(log2, { name: 'Name 3', version: 2 });

      const state = manager.getCurrentState(log3);

      expect(state.name).toBe('Name 3');
      expect(state.metadata?.version).toBe(2);
    });

    test('marks state as deactivated after deactivate event', async () => {
      const { log } = await manager.create('Test Asset', []);
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

    describe('legacy did:peer logs (back-compat read path)', () => {
      // A hand-built genesis in the pre-did:cel shape (embeds did/layer/creator).
      // getCurrentState must keep reading these verbatim.
      function legacyLog(did: string): EventLog {
        return {
          events: [{
            type: 'create',
            data: {
              name: 'Legacy Asset',
              did,
              layer: 'peer',
              resources: [{ digestMultibase: 'uHash', mediaType: 'image/png' }],
              creator: did,
              createdAt: '2020-01-01T00:00:00Z',
            },
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2020-01-01T00:00:00Z',
              verificationMethod: `${did}#key-0`,
              proofPurpose: 'assertionMethod',
              proofValue: 'zMock',
            }],
          }],
        };
      }

      test('preserves did/creator/layer from a legacy genesis', () => {
        const did = 'did:peer:4zLegacy123';
        const state = manager.getCurrentState(legacyLog(did));

        expect(state.did).toBe(did);
        expect(state.creator).toBe(did);
        expect(state.layer).toBe('peer');
      });

      test('applies legacy did/layer override on update events', () => {
        const did = 'did:peer:4zLegacy123';
        const log = legacyLog(did);
        log.events.push({
          type: 'update',
          data: { did: 'did:webvh:example.com:asset', layer: 'webvh', updatedAt: '2020-02-01T00:00:00Z' },
          previousEvent: 'uPrev',
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2020-02-01T00:00:00Z',
            verificationMethod: `${did}#key-0`,
            proofPurpose: 'assertionMethod',
            proofValue: 'zMock',
          }],
        });

        const state = manager.getCurrentState(log);
        expect(state.did).toBe('did:webvh:example.com:asset');
        expect(state.layer).toBe('webvh');
      });
    });
  });

  describe('integration: create then update then getCurrentState', () => {
    test('full lifecycle shows updated state', async () => {
      const manager = new PeerCelManager(createMockSigner());

      // Create asset
      const initialResources: ExternalReference[] = [
        { digestMultibase: 'uOriginalHash', mediaType: 'image/png' }
      ];
      const { log } = await manager.create('Original Name', initialResources);

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

      const { log } = await manager.create('Test Asset', []);
      const updatedLog = await manager.update(log, { name: 'New Name' });

      // Verify the updated log
      const result = await verifyEventLog(updatedLog);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].chainValid).toBe(true);
      expect(result.events[1].chainValid).toBe(true);
    });
  });
});
