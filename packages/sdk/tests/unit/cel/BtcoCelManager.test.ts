/**
 * BtcoCelManager Unit Tests
 * 
 * Tests for the did:btco layer manager including migration from webvh layer.
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { BtcoCelManager } from '../../../src/cel/layers/BtcoCelManager';
import { WebVHCelManager } from '../../../src/cel/layers/WebVHCelManager';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import type { EventLog, DataIntegrityProof, WitnessProof } from '../../../src/cel/types';
import type { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';

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

// Mock BitcoinManager
const createMockBitcoinManager = (): BitcoinManager => ({
  inscribeData: vi.fn().mockResolvedValue({
    txid: 'abc123def456',
    inscriptionId: 'abc123def456i0',
    satoshi: '1234567890',
    blockHeight: 800000,
  }),
  // Add other required methods as stubs
} as unknown as BitcoinManager);

// Mock BitcoinManager that fails
const createFailingBitcoinManager = (): BitcoinManager => ({
  inscribeData: vi.fn().mockRejectedValue(new Error('Bitcoin network unavailable')),
} as unknown as BitcoinManager);

// Helper to create a webvh layer log for testing
const createWebvhLog = async (): Promise<EventLog> => {
  const peerManager = new PeerCelManager(createMockSigner());
  const peerLog = await peerManager.create('Test Asset', [
    { digestMultibase: 'uTestHash123', mediaType: 'image/png' },
  ]);
  
  const webvhManager = new WebVHCelManager(createMockSigner(), 'example.com');
  return webvhManager.migrate(peerLog);
};

// Helper to create a peer layer log for testing
const createPeerLog = async (): Promise<EventLog> => {
  const peerManager = new PeerCelManager(createMockSigner());
  return peerManager.create('Test Asset', [
    { digestMultibase: 'uTestHash123', mediaType: 'image/png' },
  ]);
};

describe('BtcoCelManager', () => {
  describe('constructor', () => {
    it('should create instance with valid signer and BitcoinManager', () => {
      const manager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      expect(manager).toBeDefined();
      expect(manager.bitcoin).toBeDefined();
    });

    it('should throw error for non-function signer', () => {
      expect(() => new BtcoCelManager(null as any, createMockBitcoinManager())).toThrow(
        'BtcoCelManager requires a signer function'
      );
    });

    it('should throw error for missing BitcoinManager', () => {
      expect(() => new BtcoCelManager(createMockSigner(), null as any)).toThrow(
        'BtcoCelManager requires a BitcoinManager instance'
      );
    });

    it('should accept custom config', () => {
      const manager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager(), {
        verificationMethod: 'did:key:z6MkCustom#key-0',
        proofPurpose: 'authentication',
        feeRate: 10,
      });
      expect(manager).toBeDefined();
    });
  });

  describe('migrate', () => {
    let manager: BtcoCelManager;
    let bitcoinManager: BitcoinManager;

    beforeEach(() => {
      bitcoinManager = createMockBitcoinManager();
      manager = new BtcoCelManager(createMockSigner(), bitcoinManager);
    });

    it('should migrate a webvh log to btco layer', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      expect(btcoLog).toBeDefined();
      expect(btcoLog.events.length).toBe(3); // create + webvh migration + btco migration
    });

    it('should add migration event with correct type', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      expect(migrationEvent.type).toBe('update');
    });

    it('should include sourceDid in migration data', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.sourceDid).toBeDefined();
      expect(typeof migrationData.sourceDid).toBe('string');
      expect((migrationData.sourceDid as string).startsWith('did:webvh:')).toBe(true);
    });

    it('should include targetDid with btco format', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.targetDid).toBeDefined();
      expect(typeof migrationData.targetDid).toBe('string');
      expect((migrationData.targetDid as string).startsWith('did:btco:')).toBe(true);
    });

    it('should include layer: btco in migration data', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.layer).toBe('btco');
    });

    it('should include txid in migration data', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.txid).toBe('abc123def456');
    });

    it('should include inscriptionId in migration data', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.inscriptionId).toBe('abc123def456i0');
    });

    it('should include migratedAt timestamp', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      expect(migrationData.migratedAt).toBeDefined();
      // Should be valid ISO timestamp
      expect(() => new Date(migrationData.migratedAt as string)).not.toThrow();
    });

    it('should have previousEvent linking to webvh event', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      expect(migrationEvent.previousEvent).toBeDefined();
      expect(migrationEvent.previousEvent!.startsWith('u')).toBe(true); // multibase prefix
    });

    it('should have Bitcoin witness proof on migration event', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      expect(migrationEvent.proof).toBeDefined();
      expect(migrationEvent.proof.length).toBe(2); // controller + bitcoin witness
      
      // Find Bitcoin witness proof
      const bitcoinProof = migrationEvent.proof.find(
        p => p.cryptosuite === 'bitcoin-ordinals-2024'
      );
      expect(bitcoinProof).toBeDefined();
    });

    it('should have witnessedAt on Bitcoin witness proof', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      const witnessProof = migrationEvent.proof.find(
        p => p.cryptosuite === 'bitcoin-ordinals-2024'
      ) as WitnessProof;
      expect(witnessProof.witnessedAt).toBeDefined();
    });

    it('should call inscribeData on BitcoinManager', async () => {
      const webvhLog = await createWebvhLog();
      await manager.migrate(webvhLog);

      expect(bitcoinManager.inscribeData).toHaveBeenCalled();
    });

    it('should not mutate input log', async () => {
      const webvhLog = await createWebvhLog();
      const originalLength = webvhLog.events.length;
      
      await manager.migrate(webvhLog);
      
      expect(webvhLog.events.length).toBe(originalLength);
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

    it('should throw if source layer is peer (not webvh)', async () => {
      const peerLog = await createPeerLog();
      await expect(manager.migrate(peerLog)).rejects.toThrow(
        'Cannot migrate from peer layer to btco layer. Must migrate to webvh first.'
      );
    });

    it('should throw for deactivated log', async () => {
      const webvhLog = await createWebvhLog();
      const deactivatedLog: EventLog = {
        events: [
          ...webvhLog.events,
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

    it('should propagate Bitcoin service errors', async () => {
      const failingManager = new BtcoCelManager(
        createMockSigner(),
        createFailingBitcoinManager()
      );
      
      const webvhLog = await createWebvhLog();
      await expect(failingManager.migrate(webvhLog)).rejects.toThrow('Bitcoin');
    });
  });

  describe('getCurrentState', () => {
    let manager: BtcoCelManager;

    beforeEach(() => {
      manager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
    });

    it('should return state after migration', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.layer).toBe('btco');
      expect(state.did.startsWith('did:btco:')).toBe(true);
    });

    it('should preserve original name after migration', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.name).toBe('Test Asset');
    });

    it('should include Bitcoin metadata', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.metadata?.txid).toBe('abc123def456');
      expect(state.metadata?.inscriptionId).toBe('abc123def456i0');
    });

    it('should include sourceDid in metadata', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.metadata?.sourceDid).toBeDefined();
      expect((state.metadata?.sourceDid as string).startsWith('did:webvh:')).toBe(true);
    });

    it('should have migratedAt as updatedAt', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.updatedAt).toBeDefined();
    });

    it('should not be deactivated after migration', async () => {
      const webvhLog = await createWebvhLog();
      const btcoLog = await manager.migrate(webvhLog);

      const state = manager.getCurrentState(btcoLog);

      expect(state.deactivated).toBe(false);
    });

    it('should throw for empty log', () => {
      expect(() => manager.getCurrentState({ events: [] })).toThrow(
        'Cannot get state from an empty event log'
      );
    });

    it('should throw if first event is not create', () => {
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

  describe('integration: peer to webvh to btco migration', () => {
    it('should complete full migration cycle', async () => {
      // Create peer asset
      const peerManager = new PeerCelManager(createMockSigner());
      const peerLog = await peerManager.create('My Artwork', [
        { digestMultibase: 'uArtworkHash', mediaType: 'image/jpeg' },
      ]);

      // Verify peer state
      const peerState = peerManager.getCurrentState(peerLog);
      expect(peerState.layer).toBe('peer');
      expect(peerState.name).toBe('My Artwork');

      // Migrate to webvh
      const webvhManager = new WebVHCelManager(createMockSigner(), 'gallery.example.com');
      const webvhLog = await webvhManager.migrate(peerLog);

      // Verify webvh state
      const webvhState = webvhManager.getCurrentState(webvhLog);
      expect(webvhState.layer).toBe('webvh');
      expect(webvhState.name).toBe('My Artwork');

      // Migrate to btco
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      // Verify btco state
      const btcoState = btcoManager.getCurrentState(btcoLog);
      expect(btcoState.layer).toBe('btco');
      expect(btcoState.name).toBe('My Artwork');
      expect(btcoState.did.startsWith('did:btco:')).toBe(true);
      expect(btcoState.metadata?.sourceDid).toBe(webvhState.did);
      expect(btcoState.metadata?.txid).toBeDefined();
    });

    it('should preserve resources through migration', async () => {
      const peerManager = new PeerCelManager(createMockSigner());
      const resources = [
        { digestMultibase: 'uHash1', mediaType: 'image/png' },
        { digestMultibase: 'uHash2', mediaType: 'video/mp4' },
      ];
      const peerLog = await peerManager.create('Multi-Resource', resources);

      const webvhManager = new WebVHCelManager(createMockSigner(), 'example.com');
      const webvhLog = await webvhManager.migrate(peerLog);

      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      const state = btcoManager.getCurrentState(btcoLog);
      expect(state.resources.length).toBe(2);
    });

    it('should verify migrated log has correct event chain', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      // First event: create
      expect(btcoLog.events[0].type).toBe('create');
      expect(btcoLog.events[0].previousEvent).toBeUndefined();

      // Second event: webvh migration
      expect(btcoLog.events[1].type).toBe('update');
      expect(btcoLog.events[1].previousEvent).toBeDefined();

      // Third event: btco migration
      expect(btcoLog.events[2].type).toBe('update');
      expect(btcoLog.events[2].previousEvent).toBeDefined();
    });

    it('should have three events after full migration', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      expect(btcoLog.events.length).toBe(3);
    });
  });

  describe('DID generation', () => {
    it('should generate DID from inscription ID', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      const migrationData = btcoLog.events[2].data as Record<string, unknown>;
      const targetDid = migrationData.targetDid as string;
      
      // Should contain sanitized inscription ID
      expect(targetDid.startsWith('did:btco:')).toBe(true);
      expect(targetDid.includes('abc123def456i0')).toBe(true);
    });

    it('should generate consistent DIDs for same inscription', async () => {
      const mockBitcoin = createMockBitcoinManager();
      const manager1 = new BtcoCelManager(createMockSigner(), mockBitcoin);
      const manager2 = new BtcoCelManager(createMockSigner(), mockBitcoin);
      
      const webvhLog = await createWebvhLog();
      
      const log1 = await manager1.migrate(webvhLog);
      const log2 = await manager2.migrate(webvhLog);
      
      const data1 = log1.events[2].data as Record<string, unknown>;
      const data2 = log2.events[2].data as Record<string, unknown>;
      
      // Target DIDs should be consistent for same inscription ID
      expect(data1.targetDid).toBe(data2.targetDid);
    });
  });

  describe('Bitcoin witness integration', () => {
    it('should automatically add Bitcoin witness', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      
      // Should have both controller proof and Bitcoin witness
      expect(migrationEvent.proof.length).toBeGreaterThanOrEqual(2);
      
      const hasControllerProof = migrationEvent.proof.some(
        p => p.cryptosuite === 'eddsa-jcs-2022'
      );
      const hasBitcoinWitness = migrationEvent.proof.some(
        p => p.cryptosuite === 'bitcoin-ordinals-2024'
      );
      
      expect(hasControllerProof).toBe(true);
      expect(hasBitcoinWitness).toBe(true);
    });

    it('should include satoshi in Bitcoin witness proof', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      const bitcoinProof = migrationEvent.proof.find(
        p => p.cryptosuite === 'bitcoin-ordinals-2024'
      ) as Record<string, unknown>;
      
      expect(bitcoinProof.satoshi).toBe('1234567890');
    });

    it('should include blockHeight in Bitcoin witness proof', async () => {
      const webvhLog = await createWebvhLog();
      const btcoManager = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
      const btcoLog = await btcoManager.migrate(webvhLog);

      const migrationEvent = btcoLog.events[2];
      const bitcoinProof = migrationEvent.proof.find(
        p => p.cryptosuite === 'bitcoin-ordinals-2024'
      ) as Record<string, unknown>;
      
      expect(bitcoinProof.blockHeight).toBe(800000);
    });
  });
});
