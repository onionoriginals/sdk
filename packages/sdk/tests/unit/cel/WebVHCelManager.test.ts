/**
 * WebVHCelManager Unit Tests
 * 
 * Tests for the did:webvh layer manager including migration from peer layer.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { WebVHCelManager } from '../../../src/cel/layers/WebVHCelManager';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import type { EventLog, DataIntegrityProof, WitnessProof } from '../../../src/cel/types';
import type { WitnessService } from '../../../src/cel/witnesses/WitnessService';

// Mock signer that produces valid proofs
const createMockSigner = () => {
  return async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: 'did:key:z6MkTest123#key-0',
    proofPurpose: 'assertionMethod',
    proofValue: 'z' + Buffer.from('mock-signature').toString('base64'),
  });
};

// Mock witness service
const createMockWitness = (): WitnessService => ({
  async witness(digestMultibase: string): Promise<WitnessProof> {
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: 'did:key:z6MkWitness#key-0',
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + Buffer.from('witness-signature').toString('base64'),
      witnessedAt: new Date().toISOString(),
    };
  },
});

// Helper to create a peer layer log for testing
const createPeerLog = async (): Promise<EventLog> => {
  const peerManager = new PeerCelManager(createMockSigner());
  return (await peerManager.create('Test Asset', [
    { digestMultibase: 'uTestHash123', mediaType: 'image/png' },
  ])).log;
};

describe('WebVHCelManager', () => {
  describe('constructor', () => {
    it('should create instance with valid signer and domain', () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      expect(manager).toBeDefined();
      expect(manager.domainName).toBe('example.com');
      expect(manager.witnessCount).toBe(0);
    });

    it('should create instance with witnesses', () => {
      const witness = createMockWitness();
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', [witness]);
      expect(manager.witnessCount).toBe(1);
    });

    it('should create instance with multiple witnesses', () => {
      const witnesses = [createMockWitness(), createMockWitness()];
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', witnesses);
      expect(manager.witnessCount).toBe(2);
    });

    it('should throw error for non-function signer', () => {
      expect(() => new WebVHCelManager(null as any, 'example.com')).toThrow(
        'WebVHCelManager requires a signer function'
      );
    });

    it('should throw error for missing domain', () => {
      expect(() => new WebVHCelManager(createMockSigner(), '')).toThrow(
        'WebVHCelManager requires a valid domain string'
      );
    });

    it('should throw error for invalid domain format', () => {
      expect(() => new WebVHCelManager(createMockSigner(), '-invalid')).toThrow(
        'Invalid domain format'
      );
    });

    it('should accept valid domain formats', () => {
      // Simple domain
      expect(new WebVHCelManager(createMockSigner(), 'example.com')).toBeDefined();
      // Subdomain
      expect(new WebVHCelManager(createMockSigner(), 'sub.example.com')).toBeDefined();
      // Single char domain
      expect(new WebVHCelManager(createMockSigner(), 'a')).toBeDefined();
      // With numbers
      expect(new WebVHCelManager(createMockSigner(), 'example123.com')).toBeDefined();
    });

    it('should throw error for non-array witnesses', () => {
      expect(
        () => new WebVHCelManager(createMockSigner(), 'example.com', 'not-an-array' as any)
      ).toThrow('witnesses must be an array');
    });

    it('should accept custom config', () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', [], {
        verificationMethod: 'did:key:z6MkCustom#key-0',
        proofPurpose: 'authentication',
      });
      expect(manager).toBeDefined();
    });
  });

  describe('migrate', () => {
    let manager: WebVHCelManager;

    beforeEach(() => {
      manager = new WebVHCelManager(createMockSigner(), 'example.com');
    });

    it('should migrate a peer log to webvh layer', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      expect(webvhLog).toBeDefined();
      expect(webvhLog.events.length).toBe(2); // create + migration update
    });

    it('should add migration event with correct type', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      expect(migrationEvent.type).toBe('migrate');
    });

    it('emits a first-class migrate event carrying the migration payload', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events.at(-1)!;
      expect(migrationEvent.type).toBe('migrate');

      const data = migrationEvent.data as Record<string, unknown>;
      expect(data.sourceDid).toMatch(/^did:cel:/);
      expect(data.targetDid).toMatch(/^did:webvh:example\.com:/);
      expect(data.layer).toBe('webvh');
      expect(data.domain).toBe('example.com');
      expect(data.migratedAt).toBeDefined();
      // The entry type carries the discriminator; no inner data.type field.
      expect((data as { type?: unknown }).type).toBeUndefined();
    });

    it('derives the webvh id part from the did:cel suffix, truncated like did:peer', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const data = webvhLog.events[1].data as Record<string, unknown>;
      const sourceDid = data.sourceDid as string;
      expect(sourceDid.startsWith('did:cel:')).toBe(true);

      const suffix = sourceDid.slice('did:cel:'.length);
      const expectedId = suffix
        .substring(0, Math.min(32, suffix.length))
        .replace(/[^a-zA-Z0-9]/g, '');
      expect(data.targetDid).toBe(`did:webvh:example.com:${expectedId}`);
    });

    it('should include sourceDid in migration data', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationData = webvhLog.events[1].data as Record<string, unknown>;
      expect(migrationData.sourceDid).toBeDefined();
      expect(typeof migrationData.sourceDid).toBe('string');
      // New-shape genesis: the source identity is the derived did:cel
      expect((migrationData.sourceDid as string).startsWith('did:cel:')).toBe(true);
    });

    it('should include targetDid with webvh format', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationData = webvhLog.events[1].data as Record<string, unknown>;
      expect(migrationData.targetDid).toBeDefined();
      expect(typeof migrationData.targetDid).toBe('string');
      expect((migrationData.targetDid as string).startsWith('did:webvh:example.com:')).toBe(true);
    });

    it('should include layer: webvh in migration data', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationData = webvhLog.events[1].data as Record<string, unknown>;
      expect(migrationData.layer).toBe('webvh');
    });

    it('should include domain in migration data', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationData = webvhLog.events[1].data as Record<string, unknown>;
      expect(migrationData.domain).toBe('example.com');
    });

    it('should include migratedAt timestamp', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationData = webvhLog.events[1].data as Record<string, unknown>;
      expect(migrationData.migratedAt).toBeDefined();
      // Should be valid ISO timestamp
      expect(() => new Date(migrationData.migratedAt as string)).not.toThrow();
    });

    it('should have previousEvent linking to create event', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      expect(migrationEvent.previousEvent).toBeDefined();
      expect(migrationEvent.previousEvent!.startsWith('u')).toBe(true); // multibase prefix
    });

    it('should have valid proof on migration event', async () => {
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      expect(migrationEvent.proof).toBeDefined();
      expect(migrationEvent.proof.length).toBeGreaterThanOrEqual(1);
      expect(migrationEvent.proof[0].type).toBe('DataIntegrityProof');
    });

    it('should not mutate input log', async () => {
      const peerLog = await createPeerLog();
      const originalLength = peerLog.events.length;
      
      await manager.migrate(peerLog);
      
      expect(peerLog.events.length).toBe(originalLength);
    });

    it('should throw for empty log', async () => {
      const emptyLog: EventLog = { events: [] };
      await expect(manager.migrate(emptyLog)).rejects.toThrow(
        'Cannot migrate an empty event log'
      );
    });

    it('should throw for null log', async () => {
      await expect(manager.migrate(null as any)).rejects.toThrow(
        'Cannot migrate an empty event log'
      );
    });

    it('should throw if first event is not create', async () => {
      const badLog: EventLog = {
        events: [
          {
            type: 'update',
            data: {},
            proof: [
              {
                type: 'DataIntegrityProof',
                cryptosuite: 'eddsa-jcs-2022',
                created: new Date().toISOString(),
                verificationMethod: 'did:key:test',
                proofPurpose: 'assertionMethod',
                proofValue: 'zTest',
              },
            ],
          },
        ],
      };
      await expect(manager.migrate(badLog)).rejects.toThrow(
        'First event must be a create event'
      );
    });

    it('should throw if create event has no did', async () => {
      const logWithoutDid: EventLog = {
        events: [
          {
            type: 'create',
            data: { name: 'Test', layer: 'peer' }, // no did
            proof: [
              {
                type: 'DataIntegrityProof',
                cryptosuite: 'eddsa-jcs-2022',
                created: new Date().toISOString(),
                verificationMethod: 'did:key:test',
                proofPurpose: 'assertionMethod',
                proofValue: 'zTest',
              },
            ],
          },
        ],
      };
      await expect(manager.migrate(logWithoutDid)).rejects.toThrow(
        'Create event must have a did field'
      );
    });

    it('should throw if source layer is not peer', async () => {
      const webvhSourceLog: EventLog = {
        events: [
          {
            type: 'create',
            data: { 
              name: 'Test', 
              did: 'did:webvh:other.com:xyz', 
              layer: 'webvh' 
            },
            proof: [
              {
                type: 'DataIntegrityProof',
                cryptosuite: 'eddsa-jcs-2022',
                created: new Date().toISOString(),
                verificationMethod: 'did:key:test',
                proofPurpose: 'assertionMethod',
                proofValue: 'zTest',
              },
            ],
          },
        ],
      };
      await expect(manager.migrate(webvhSourceLog)).rejects.toThrow(
        'Cannot migrate from webvh layer to webvh layer'
      );
    });

    it('should throw for deactivated log', async () => {
      const peerLog = await createPeerLog();
      const deactivatedLog: EventLog = {
        events: [
          ...peerLog.events,
          {
            type: 'deactivate',
            data: { reason: 'test', deactivatedAt: new Date().toISOString() },
            previousEvent: 'uTest',
            proof: [
              {
                type: 'DataIntegrityProof',
                cryptosuite: 'eddsa-jcs-2022',
                created: new Date().toISOString(),
                verificationMethod: 'did:key:test',
                proofPurpose: 'assertionMethod',
                proofValue: 'zTest',
              },
            ],
          },
        ],
      };
      await expect(manager.migrate(deactivatedLog)).rejects.toThrow(
        'Cannot migrate a deactivated event log'
      );
    });
  });

  describe('migrate with witnesses', () => {
    it('should add witness proof when witness is configured', async () => {
      const witness = createMockWitness();
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', [witness]);
      
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      expect(migrationEvent.proof.length).toBe(2); // controller + witness
    });

    it('should add multiple witness proofs', async () => {
      const witnesses = [createMockWitness(), createMockWitness()];
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', witnesses);
      
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      expect(migrationEvent.proof.length).toBe(3); // controller + 2 witnesses
    });

    it('should have witnessedAt on witness proofs', async () => {
      const witness = createMockWitness();
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', [witness]);
      
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const migrationEvent = webvhLog.events[1];
      const witnessProof = migrationEvent.proof[1] as WitnessProof;
      expect(witnessProof.witnessedAt).toBeDefined();
    });

    it('should propagate witness service errors', async () => {
      const failingWitness: WitnessService = {
        async witness(): Promise<WitnessProof> {
          throw new Error('Witness unavailable');
        },
      };
      const manager = new WebVHCelManager(createMockSigner(), 'example.com', [failingWitness]);
      
      const peerLog = await createPeerLog();
      await expect(manager.migrate(peerLog)).rejects.toThrow('Witness unavailable');
    });
  });

  describe('getCurrentState', () => {
    it('should return state after migration', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const state = manager.getCurrentState(webvhLog);

      expect(state.layer).toBe('webvh');
      expect(state.did.startsWith('did:webvh:')).toBe(true);
    });

    it('should preserve original name after migration', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const state = manager.getCurrentState(webvhLog);

      expect(state.name).toBe('Test Asset');
    });

    it('should include migration metadata', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const state = manager.getCurrentState(webvhLog);

      expect(state.metadata?.sourceDid).toBeDefined();
      expect(state.metadata?.domain).toBe('example.com');
    });

    it('should have migratedAt as updatedAt', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const state = manager.getCurrentState(webvhLog);

      expect(state.updatedAt).toBeDefined();
    });

    it('should not be deactivated after migration', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const state = manager.getCurrentState(webvhLog);

      expect(state.deactivated).toBe(false);
    });

    it('replays a legacy update-sniffed migration (old fixture logs)', () => {
      // Legacy logs record migrations as 'update' events sniffed by
      // sourceDid+layer+migratedAt — they must keep replaying.
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const mockProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: '2020-01-01T00:00:00.000Z',
        verificationMethod: 'did:key:zLegacy#key-0',
        proofPurpose: 'assertionMethod',
        proofValue: 'zLegacy',
      };
      const legacyLog: EventLog = {
        events: [
          {
            type: 'create',
            data: {
              name: 'Legacy Asset',
              did: 'did:peer:4zLegacyDid',
              layer: 'peer',
              resources: [],
              creator: 'did:peer:4zLegacyDid',
              createdAt: '2020-01-01T00:00:00.000Z',
            },
            proof: [mockProof],
          },
          {
            type: 'update',
            data: {
              sourceDid: 'did:peer:4zLegacyDid',
              targetDid: 'did:webvh:example.com:legacy',
              layer: 'webvh',
              domain: 'example.com',
              migratedAt: '2020-01-02T00:00:00.000Z',
            },
            previousEvent: 'uLegacyDigest',
            proof: [mockProof],
          },
        ],
      };

      const state = manager.getCurrentState(legacyLog);
      expect(state.layer).toBe('webvh');
      expect(state.did).toBe('did:webvh:example.com:legacy');
      expect(state.metadata?.sourceDid).toBe('did:peer:4zLegacyDid');
      expect(state.metadata?.domain).toBe('example.com');
    });

    it('surfaces the controller and applies rotateKey hand-off in replay', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const genesisController = (webvhLog.events[0].data as Record<string, unknown>).controller as string;
      expect(manager.getCurrentState(webvhLog).controller).toBe(genesisController);

      const rotatedLog: EventLog = {
        events: [
          ...webvhLog.events,
          {
            type: 'rotateKey',
            data: { newController: 'did:key:z6MkNewController', rotatedAt: '2026-01-01T00:00:00.000Z' },
            previousEvent: 'uRotate',
            proof: webvhLog.events[0].proof,
          },
        ],
      };
      const state = manager.getCurrentState(rotatedLog);
      expect(state.controller).toBe('did:key:z6MkNewController');
    });

    it('replays first-class transfer events into owner metadata', async () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const peerLog = await createPeerLog();
      const webvhLog = await manager.migrate(peerLog);

      const transferredLog: EventLog = {
        events: [
          ...webvhLog.events,
          {
            type: 'transfer',
            data: {
              previousOwner: 'did:key:z6MkOldOwner',
              newOwner: 'bc1qnewowner',
              transferredAt: '2026-02-01T00:00:00.000Z',
              txid: 'feedface',
            },
            previousEvent: 'uTransfer',
            proof: webvhLog.events[0].proof,
          },
        ],
      };
      const state = manager.getCurrentState(transferredLog);
      expect(state.metadata?.previousOwner).toBe('did:key:z6MkOldOwner');
      expect(state.metadata?.newOwner).toBe('bc1qnewowner');
      expect(state.metadata?.txid).toBe('feedface');
      expect(state.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('should throw for empty log', () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      expect(() => manager.getCurrentState({ events: [] })).toThrow(
        'Cannot get state from an empty event log'
      );
    });

    it('should throw if first event is not create', () => {
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const badLog: EventLog = {
        events: [
          {
            type: 'update',
            data: {},
            proof: [],
          },
        ],
      };
      expect(() => manager.getCurrentState(badLog)).toThrow(
        'First event must be a create event'
      );
    });
  });

  describe('integration: peer to webvh migration', () => {
    it('should complete full migration cycle', async () => {
      // Create peer asset
      const peerManager = new PeerCelManager(createMockSigner());
      const { log: peerLog } = await peerManager.create('My Artwork', [
        { digestMultibase: 'uArtworkHash', mediaType: 'image/jpeg' },
      ]);

      // Verify peer state
      const peerState = peerManager.getCurrentState(peerLog);
      expect(peerState.layer).toBe('peer');
      expect(peerState.name).toBe('My Artwork');

      // Migrate to webvh
      const witness = createMockWitness();
      const webvhManager = new WebVHCelManager(
        createMockSigner(),
        'gallery.example.com',
        [witness]
      );
      const webvhLog = await webvhManager.migrate(peerLog);

      // Verify webvh state
      const webvhState = webvhManager.getCurrentState(webvhLog);
      expect(webvhState.layer).toBe('webvh');
      expect(webvhState.name).toBe('My Artwork');
      expect(webvhState.did.startsWith('did:webvh:gallery.example.com:')).toBe(true);
      expect(webvhState.metadata?.sourceDid).toBe(peerState.did);
    });

    it('should preserve resources through migration', async () => {
      const peerManager = new PeerCelManager(createMockSigner());
      const resources = [
        { digestMultibase: 'uHash1', mediaType: 'image/png' },
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' },
      ];
      const { log: peerLog } = await peerManager.create('Multi-Resource', resources);

      const webvhManager = new WebVHCelManager(createMockSigner(), 'example.com');
      const webvhLog = await webvhManager.migrate(peerLog);

      const state = webvhManager.getCurrentState(webvhLog);
      expect(state.resources.length).toBe(2);
    });

    it('should verify migrated log has correct event chain', async () => {
      const peerLog = await createPeerLog();
      const manager = new WebVHCelManager(createMockSigner(), 'example.com');
      const webvhLog = await manager.migrate(peerLog);

      // First event: create
      expect(webvhLog.events[0].type).toBe('create');
      expect(webvhLog.events[0].previousEvent).toBeUndefined();

      // Second event: first-class migration event
      expect(webvhLog.events[1].type).toBe('migrate');
      expect(webvhLog.events[1].previousEvent).toBeDefined();
    });
  });

  describe('DID generation', () => {
    it('should generate consistent DIDs for same source', async () => {
      const peerLog = await createPeerLog();
      const sourceDid = (peerLog.events[0].data as Record<string, unknown>).did as string;
      
      const manager1 = new WebVHCelManager(createMockSigner(), 'example.com');
      const manager2 = new WebVHCelManager(createMockSigner(), 'example.com');
      
      const log1 = await manager1.migrate(peerLog);
      const log2 = await manager2.migrate(peerLog);
      
      const data1 = log1.events[1].data as Record<string, unknown>;
      const data2 = log2.events[1].data as Record<string, unknown>;
      
      // Target DIDs should be consistent for same source
      expect(data1.targetDid).toBe(data2.targetDid);
    });

    it('should use different domains in DID', async () => {
      const peerLog = await createPeerLog();
      
      const manager1 = new WebVHCelManager(createMockSigner(), 'example.com');
      const manager2 = new WebVHCelManager(createMockSigner(), 'other.com');
      
      const log1 = await manager1.migrate(peerLog);
      const log2 = await manager2.migrate(peerLog);
      
      const data1 = log1.events[1].data as Record<string, unknown>;
      const data2 = log2.events[1].data as Record<string, unknown>;
      
      expect((data1.targetDid as string).includes('example.com')).toBe(true);
      expect((data2.targetDid as string).includes('other.com')).toBe(true);
    });
  });
});
