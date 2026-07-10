/**
 * Tests for OriginalsCel unified SDK entry point
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OriginalsCel, type CelSigner, type OriginalsCelConfig } from '../../../src/cel/OriginalsCel';
import type { DataIntegrityProof, EventLog, ExternalReference } from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';

/**
 * Creates a real Ed25519 did:key signer.  The key is embedded in the DID
 * identifier, so `verifyEventLog` can verify it offline without a resolver.
 *
 * For tests that only need proof *structure* (e.g. migration tests that don't
 * call verify), the mock signer below is still used.
 */
async function createRealDidKeySigner(): Promise<CelSigner> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomSecretKey();
  const publicKeyBytes = new Uint8Array(
    await (ed25519 as any).getPublicKeyAsync(privateKeyBytes),
  );
  const publicKeyMultikey = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  const verificationMethod = `did:key:${publicKeyMultikey}#${publicKeyMultikey}`;

  return async (data: unknown): Promise<DataIntegrityProof> => {
    const dataBytes = canonicalizeEvent(data);
    const signature = await (ed25519 as any).signAsync(dataBytes, privateKeyBytes);
    const proofValue = multikey.encodeMultibase(new Uint8Array(signature));
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue,
    };
  };
}

/**
 * Creates a mock signer that returns structurally valid DataIntegrityProofs.
 * Uses a non-did:key verificationMethod — proofs from this signer will fail
 * closed during verify (no resolver).  Use only for tests that do NOT call
 * cel.verify() with an expectation of verified: true.
 */
function createMockSigner(): CelSigner {
  return vi.fn(async () => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: 'did:web:example.com#key-0',
    proofPurpose: 'assertionMethod',
    proofValue: 'z' + 'a'.repeat(86), // Mock base58btc encoded signature
  }));
}

/**
 * Creates a mock Bitcoin manager for testing
 */
function createMockBitcoinManager() {
  return {
    inscribeData: vi.fn(async () => ({
      txid: 'mock-txid-' + Math.random().toString(36).substring(7),
      inscriptionId: 'mock-inscription-' + Math.random().toString(36).substring(7),
      satoshi: 1000,
      blockHeight: 800000,
    })),
  } as any;
}

describe('OriginalsCel', () => {
  let mockSigner: CelSigner;

  beforeEach(() => {
    mockSigner = createMockSigner();
  });

  describe('constructor', () => {
    it('creates instance with valid peer layer config', () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      expect(cel).toBeInstanceOf(OriginalsCel);
      expect(cel.currentLayer).toBe('peer');
    });

    it('creates instance with valid webvh layer config', () => {
      const cel = new OriginalsCel({
        layer: 'webvh',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      expect(cel).toBeInstanceOf(OriginalsCel);
      expect(cel.currentLayer).toBe('webvh');
    });

    it('creates instance with valid btco layer config', () => {
      const cel = new OriginalsCel({
        layer: 'btco',
        signer: mockSigner,
        config: {
          btco: {
            bitcoinManager: createMockBitcoinManager(),
          },
        },
      });

      expect(cel).toBeInstanceOf(OriginalsCel);
      expect(cel.currentLayer).toBe('btco');
    });

    it('throws error if signer is not a function', () => {
      expect(() => {
        new OriginalsCel({
          layer: 'peer',
          signer: 'not a function' as any,
        });
      }).toThrow('OriginalsCel requires a signer function');
    });

    it('throws error for invalid layer', () => {
      expect(() => {
        new OriginalsCel({
          layer: 'invalid' as any,
          signer: mockSigner,
        });
      }).toThrow('Invalid layer: invalid');
    });

    it('accepts optional config', () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          peer: {
            verificationMethod: 'did:key:z123#key-0',
            proofPurpose: 'authentication',
          },
        },
      });

      expect(cel).toBeInstanceOf(OriginalsCel);
    });
  });

  describe('create', () => {
    it('creates an asset at peer layer', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const resources: ExternalReference[] = [
        {
          digestMultibase: 'uEi' + 'A'.repeat(43),
          mediaType: 'image/png',
        },
      ];

      const { log } = await cel.create('Test Asset', resources);

      expect(log).toBeDefined();
      expect(log.events).toHaveLength(1);
      expect(log.events[0].type).toBe('create');
      
      const data = log.events[0].data as any;
      expect(data.name).toBe('Test Asset');
      // De-self-referenced genesis: no embedded did/layer, holder in controller
      expect(data.did).toBeUndefined();
      expect(data.layer).toBeUndefined();
      expect(typeof data.controller).toBe('string');
      expect(data.resources).toHaveLength(1);
    });

    it('throws error when creating at non-peer layer', async () => {
      const cel = new OriginalsCel({
        layer: 'webvh',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      await expect(cel.create('Test', [])).rejects.toThrow(
        'Cannot create assets at webvh layer directly'
      );
    });

    it('returns a derived did:cel for new assets', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log, did } = await cel.create('Test', []);
      const data = log.events[0].data as any;

      expect(did).toMatch(/^did:cel:u/);
      expect(data.did).toBeUndefined();
    });

    it('includes proof in create event', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);

      expect(log.events[0].proof).toHaveLength(1);
      expect(log.events[0].proof[0].type).toBe('DataIntegrityProof');
      expect(log.events[0].proof[0].cryptosuite).toBe('eddsa-jcs-2022');
    });

    it('calls signer function', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      await cel.create('Test', []);

      expect(mockSigner).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates a peer layer log', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const updated = await cel.update(log, { description: 'Updated' });

      expect(updated.events).toHaveLength(2);
      expect(updated.events[1].type).toBe('update');
      
      const data = updated.events[1].data as any;
      expect(data.description).toBe('Updated');
      expect(data.updatedAt).toBeDefined();
    });

    it('links to previous event via hash chain', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const updated = await cel.update(log, { foo: 'bar' });

      expect(updated.events[1].previousEvent).toBeDefined();
      expect(updated.events[1].previousEvent).toMatch(/^u/); // multibase prefix
    });

    it('rejects reserved migration fields in update data (would be misclassified as a migration)', async () => {
      // Regression: getCurrentLayer treats an update carrying sourceDid+layer as
      // a migration. A regular update must not be able to smuggle those fields.
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });
      const { log } = await cel.create('Test', []);

      for (const badData of [
        { sourceDid: 'did:peer:x', layer: 'peer' },
        { layer: 'webvh' },
        { targetDid: 'did:webvh:example.com:x' },
        { migratedAt: new Date().toISOString() },
      ]) {
        await expect(cel.update(log, badData as any)).rejects.toThrow(/reserved migration field/i);
      }

      // A normal metadata update with the same layer count still works.
      const ok = await cel.update(log, { description: 'fine' });
      expect(ok.events).toHaveLength(2);
      expect(cel.getCurrentState(ok).layer).toBe('peer');
    });

    it('preserves original event in updated log', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const updated = await cel.update(log, { foo: 'bar' });

      expect(updated.events[0]).toEqual(log.events[0]);
    });

    it('does not mutate input log', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const originalLength = log.events.length;
      
      await cel.update(log, { foo: 'bar' });

      expect(log.events.length).toBe(originalLength);
    });
  });

  describe('verify', () => {
    it('verifies valid peer log', async () => {
      // Use a real did:key signer so cryptographic verification passes offline.
      const realSigner = await createRealDidKeySigner();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: realSigner,
      });

      const { log } = await cel.create('Test', []);
      const result = await cel.verify(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('verifies valid log with updates', async () => {
      const realSigner = await createRealDidKeySigner();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: realSigner,
      });

      const { log } = await cel.create('Test', []);
      const updated = await cel.update(log, { foo: 'bar' });
      const result = await cel.verify(updated);

      expect(result.verified).toBe(true);
      expect(result.events).toHaveLength(2);
    });

    it('returns per-event verification details', async () => {
      const realSigner = await createRealDidKeySigner();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: realSigner,
      });

      const { log } = await cel.create('Test', []);
      const result = await cel.verify(log);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].index).toBe(0);
      expect(result.events[0].type).toBe('create');
      expect(result.events[0].proofValid).toBe(true);
      expect(result.events[0].chainValid).toBe(true);
    });

    it('fails for empty log', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const emptyLog: EventLog = { events: [] };
      const result = await cel.verify(emptyLog);

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('fails for tampered proof', async () => {
      const realSigner = await createRealDidKeySigner();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: realSigner,
      });

      const { log } = await cel.create('Test', []);

      // Tamper with the proof
      log.events[0].proof[0].proofValue = 'zinvalid';

      const result = await cel.verify(log);

      expect(result.verified).toBe(false);
    });

    it('accepts custom verifier', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const customVerifier = vi.fn(async () => true);

      const result = await cel.verify(log, { verifier: customVerifier });

      expect(result.verified).toBe(true);
      expect(customVerifier).toHaveBeenCalled();
    });
  });

  describe('migrate', () => {
    it('migrates peer to webvh', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      const { log } = await cel.create('Test', []);
      const migrated = await cel.migrate(log, 'webvh');

      expect(migrated.events).toHaveLength(2);
      expect(migrated.events[1].type).toBe('update');
      
      const data = migrated.events[1].data as any;
      expect(data.layer).toBe('webvh');
      expect(data.targetDid).toMatch(/^did:webvh:/);
      expect(data.domain).toBe('example.com');
    });

    it('throws error for migration to same layer', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);

      await expect(cel.migrate(log, 'peer')).rejects.toThrow(
        'Log is already at peer layer'
      );
    });

    it('throws error for migration to peer layer', async () => {
      const cel = new OriginalsCel({
        layer: 'webvh',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      const peerCel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });
      const { log } = await peerCel.create('Test', []);
      const webvhLog = await cel.migrate(log, 'webvh');

      await expect(cel.migrate(webvhLog, 'peer' as any)).rejects.toThrow(
        'Cannot migrate to peer layer'
      );
    });

    it('throws error for direct peer to btco migration', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          btco: {
            bitcoinManager: createMockBitcoinManager(),
          },
        },
      });

      const { log } = await cel.create('Test', []);

      await expect(cel.migrate(log, 'btco')).rejects.toThrow(
        'Cannot migrate directly from peer to btco'
      );
    });

    it('throws error when webvh domain not configured', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);

      await expect(cel.migrate(log, 'webvh')).rejects.toThrow(
        'WebVH operations require a domain'
      );
    });

    it('allows domain in migrate options', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const migrated = await cel.migrate(log, 'webvh', { domain: 'test.com' });

      const data = migrated.events[1].data as any;
      expect(data.domain).toBe('test.com');
    });

    it('migrates webvh to btco', async () => {
      const mockBitcoinManager = createMockBitcoinManager();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
          btco: {
            bitcoinManager: mockBitcoinManager,
          },
        },
      });

      const { log: peerLog } = await cel.create('Test', []);
      const webvhLog = await cel.migrate(peerLog, 'webvh');
      const btcoLog = await cel.migrate(webvhLog, 'btco');

      expect(btcoLog.events).toHaveLength(3);
      
      const data = btcoLog.events[2].data as any;
      expect(data.layer).toBe('btco');
      // The resolvable did:btco:<satoshi> comes from the witness proof via the
      // derived state (not the signed data — the satoshi is only known after
      // inscription).
      const bp = (btcoLog.events[2].proof as any[]).find(p => p.cryptosuite === 'bitcoin-ordinals-2024');
      expect(String(bp.satoshi).length).toBeGreaterThan(0);
      expect(mockBitcoinManager.inscribeData).toHaveBeenCalled();
    });

    it('getCurrentState(btcoLog) resolves the canonical did:btco:<satoshi>, not the webvh DID', async () => {
      // Regression for the #228 targetDid/sourceDid detector mismatch: btco
      // migration events carry sourceDid (not targetDid), so a detector keyed on
      // targetDid mis-routed btco logs through the webvh manager and left the
      // state DID as the old webvh DID instead of did:btco:<satoshi>.
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: { domain: 'example.com' },
          btco: { bitcoinManager: createMockBitcoinManager() },
        },
      });

      const { log: peerLog } = await cel.create('Test', []);
      const webvhLog = await cel.migrate(peerLog, 'webvh');
      const btcoLog = await cel.migrate(webvhLog, 'btco');

      const state = cel.getCurrentState(btcoLog);
      expect(state.layer).toBe('btco');
      // Mock inscribes at satoshi 1000.
      expect(state.did).toBe('did:btco:1000');
      expect(state.did.startsWith('did:webvh:')).toBe(false);
    });

    it('rejects a second migration to btco (btco is the terminal layer)', async () => {
      // Regression: the terminal-layer guard depends on detecting that the log
      // is already at btco; the targetDid-keyed detector reported it as webvh
      // and let a second inscription through.
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: { domain: 'example.com' },
          btco: { bitcoinManager: createMockBitcoinManager() },
        },
      });

      const { log: peerLog } = await cel.create('Test', []);
      const webvhLog = await cel.migrate(peerLog, 'webvh');
      const btcoLog = await cel.migrate(webvhLog, 'btco');

      await expect(cel.migrate(btcoLog, 'btco')).rejects.toThrow(/btco/i);
    });

    it('throws error when bitcoinManager not configured for btco', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      const { log } = await cel.create('Test', []);
      const webvhLog = await cel.migrate(log, 'webvh');

      await expect(cel.migrate(webvhLog, 'btco')).rejects.toThrow(
        'BTCO operations require a BitcoinManager'
      );
    });
  });

  describe('getCurrentState', () => {
    it('returns state for peer log', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test Asset', [
        { digestMultibase: 'uXYZ', mediaType: 'image/png' },
      ]);

      const state = cel.getCurrentState(log);

      expect(state.name).toBe('Test Asset');
      expect(state.layer).toBe('peer');
      expect(state.resources).toHaveLength(1);
      expect(state.deactivated).toBe(false);
      expect(state.did).toMatch(/^did:cel:/);
    });

    it('returns updated state after update', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Original', []);
      const updated = await cel.update(log, { name: 'Updated Name' });

      const state = cel.getCurrentState(updated);

      expect(state.name).toBe('Updated Name');
      expect(state.updatedAt).toBeDefined();
    });

    it('returns migrated state after migration', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
        },
      });

      const { log } = await cel.create('Test', []);
      const migrated = await cel.migrate(log, 'webvh');

      const state = cel.getCurrentState(migrated);

      expect(state.layer).toBe('webvh');
      expect(state.did).toMatch(/^did:webvh:/);
      expect(state.metadata?.sourceDid).toBeDefined();
    });

    it('includes metadata in state', async () => {
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const { log } = await cel.create('Test', []);
      const updated = await cel.update(log, { 
        customField: 'custom value',
        tags: ['art', 'digital'],
      });

      const state = cel.getCurrentState(updated);

      expect(state.metadata?.customField).toBe('custom value');
      expect(state.metadata?.tags).toEqual(['art', 'digital']);
    });
  });

  describe('currentLayer', () => {
    it('returns configured layer', () => {
      const peerCel = new OriginalsCel({
        layer: 'peer',
        signer: mockSigner,
      });

      const webvhCel = new OriginalsCel({
        layer: 'webvh',
        signer: mockSigner,
        config: { webvh: { domain: 'test.com' } },
      });

      const btcoCel = new OriginalsCel({
        layer: 'btco',
        signer: mockSigner,
        config: { btco: { bitcoinManager: createMockBitcoinManager() } },
      });

      expect(peerCel.currentLayer).toBe('peer');
      expect(webvhCel.currentLayer).toBe('webvh');
      expect(btcoCel.currentLayer).toBe('btco');
    });
  });

  describe('integration: full lifecycle', () => {
    it('creates, updates, migrates, and verifies', async () => {
      const mockBitcoinManager = createMockBitcoinManager();
      // Use a real did:key signer so peer/webvh events pass offline crypto verify.
      const realSigner = await createRealDidKeySigner();
      const cel = new OriginalsCel({
        layer: 'peer',
        signer: realSigner,
        config: {
          webvh: {
            domain: 'example.com',
          },
          btco: {
            bitcoinManager: mockBitcoinManager,
          },
        },
      });

      // Custom verifier that accepts bitcoin-ordinals-2024 cryptosuite as well
      const permissiveVerifier = async (proof: DataIntegrityProof) => {
        const validSuites = ['eddsa-jcs-2022', 'eddsa-rdfc-2022', 'bitcoin-ordinals-2024'];
        if (!proof.type || proof.type !== 'DataIntegrityProof') return false;
        if (!validSuites.includes(proof.cryptosuite)) return false;
        if (!proof.proofValue || typeof proof.proofValue !== 'string') return false;
        return true;
      };

      // Create
      const { log: peerLog } = await cel.create('My Original', [
        { digestMultibase: 'uXYZ', mediaType: 'image/png' },
      ]);
      expect((await cel.verify(peerLog)).verified).toBe(true);

      // Update
      const updatedLog = await cel.update(peerLog, {
        description: 'A unique digital artwork',
      });
      expect((await cel.verify(updatedLog)).verified).toBe(true);

      // Migrate to webvh
      const webvhLog = await cel.migrate(updatedLog, 'webvh');
      expect((await cel.verify(webvhLog)).verified).toBe(true);
      expect(cel.getCurrentState(webvhLog).layer).toBe('webvh');

      // Migrate to btco
      const btcoLog = await cel.migrate(webvhLog, 'btco');
      // Use permissive verifier that recognizes bitcoin-ordinals-2024 cryptosuite
      expect((await cel.verify(btcoLog, { verifier: permissiveVerifier })).verified).toBe(true);
      expect(cel.getCurrentState(btcoLog).layer).toBe('btco');

      // Final state
      const finalState = cel.getCurrentState(btcoLog);
      expect(finalState.name).toBe('My Original');
      expect(finalState.layer).toBe('btco');
      expect(finalState.deactivated).toBe(false);
      expect(finalState.metadata?.description).toBe('A unique digital artwork');
    });
  });
});
