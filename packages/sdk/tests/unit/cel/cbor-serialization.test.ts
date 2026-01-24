import { describe, test, expect } from 'bun:test';
import { serializeEventLogCbor, parseEventLogCbor } from '../../../src/cel/serialization/cbor';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import type { EventLog, DataIntegrityProof, WitnessProof } from '../../../src/cel/types';

// Mock signer for testing
const mockSigner = async (data: unknown): Promise<DataIntegrityProof> => ({
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: new Date().toISOString(),
  verificationMethod: 'did:key:z6Mktest#key-1',
  proofPurpose: 'assertionMethod',
  proofValue: 'zMockProofValue123',
});

describe('CEL CBOR Serialization', () => {
  describe('serializeEventLogCbor', () => {
    test('serializes a simple event log to Uint8Array', async () => {
      const log = await createEventLog({ name: 'Test Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);

      expect(cbor).toBeInstanceOf(Uint8Array);
      expect(cbor.length).toBeGreaterThan(0);
    });

    test('produces valid CBOR that can be decoded', async () => {
      const log = await createEventLog({ name: 'Test' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      
      // Should not throw when parsing
      const parsed = parseEventLogCbor(cbor);
      expect(parsed).toBeDefined();
      expect(parsed.events).toBeDefined();
    });

    test('serializes multiple events correctly', async () => {
      let log = await createEventLog({ name: 'Test Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });
      log = await updateEventLog(log, { name: 'Updated Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events.length).toBe(2);
      expect(parsed.events[0].type).toBe('create');
      expect(parsed.events[1].type).toBe('update');
    });

    test('preserves previousLog field', () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: 'did:key:z6Mktest#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zMockProofValue123',
          }],
        }],
        previousLog: 'uPreviousLogHash123',
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.previousLog).toBe('uPreviousLogHash123');
    });

    test('throws on null input', () => {
      expect(() => serializeEventLogCbor(null as unknown as EventLog)).toThrow('Cannot serialize null or undefined EventLog');
    });

    test('throws on undefined input', () => {
      expect(() => serializeEventLogCbor(undefined as unknown as EventLog)).toThrow('Cannot serialize null or undefined EventLog');
    });

    test('serializes witness proofs with witnessedAt field', () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zControllerProof',
            },
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:01Z',
              verificationMethod: 'did:web:witness.example.com#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zWitnessProof',
              witnessedAt: '2026-01-20T12:00:01Z',
            } as WitnessProof,
          ],
        }],
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect((parsed.events[0].proof[1] as WitnessProof).witnessedAt).toBe('2026-01-20T12:00:01Z');
    });
  });

  describe('parseEventLogCbor', () => {
    test('parses valid CBOR data to EventLog', () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test Asset' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: 'did:key:z6Mktest#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zMockProofValue123',
          }],
        }],
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events.length).toBe(1);
      expect(parsed.events[0].type).toBe('create');
      expect((parsed.events[0].data as { name: string }).name).toBe('Test Asset');
    });

    test('parses log with multiple events', () => {
      const log: EventLog = {
        events: [
          {
            type: 'create',
            data: { name: 'Test' },
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zProof1',
            }],
          },
          {
            type: 'update',
            data: { name: 'Updated' },
            previousEvent: 'uHashOfPreviousEvent',
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:01Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zProof2',
            }],
          },
        ],
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events.length).toBe(2);
      expect(parsed.events[0].type).toBe('create');
      expect(parsed.events[1].type).toBe('update');
      expect(parsed.events[1].previousEvent).toBe('uHashOfPreviousEvent');
    });

    test('parses previousLog field', () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: {},
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: 'did:key:z6Mktest#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zProof',
          }],
        }],
        previousLog: 'uChunkHash123',
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.previousLog).toBe('uChunkHash123');
    });

    test('parses witness proofs correctly', () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: {},
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zControllerProof',
            },
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:01Z',
              verificationMethod: 'did:web:witness#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zWitnessProof',
              witnessedAt: '2026-01-20T12:00:01Z',
            } as WitnessProof,
          ],
        }],
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);
      const witnessProof = parsed.events[0].proof[1] as WitnessProof;

      expect(witnessProof.witnessedAt).toBe('2026-01-20T12:00:01Z');
    });

    test('throws on null input', () => {
      expect(() => parseEventLogCbor(null as unknown as Uint8Array)).toThrow('Cannot parse null, undefined, or non-Uint8Array value');
    });

    test('throws on undefined input', () => {
      expect(() => parseEventLogCbor(undefined as unknown as Uint8Array)).toThrow('Cannot parse null, undefined, or non-Uint8Array value');
    });

    test('throws on non-Uint8Array input', () => {
      expect(() => parseEventLogCbor('not a Uint8Array' as unknown as Uint8Array)).toThrow('Cannot parse null, undefined, or non-Uint8Array value');
    });

    test('throws on empty CBOR data', () => {
      expect(() => parseEventLogCbor(new Uint8Array(0))).toThrow('Cannot parse empty CBOR data');
    });

    test('throws on invalid CBOR data', () => {
      const invalidCbor = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      expect(() => parseEventLogCbor(invalidCbor)).toThrow();
    });

    test('throws on missing events array', () => {
      const { encode } = require('../../../src/utils/cbor');
      const cbor = encode({ notEvents: [] });
      expect(() => parseEventLogCbor(cbor)).toThrow('Invalid EventLog: events must be an array');
    });

    test('throws on invalid event type', () => {
      const { encode } = require('../../../src/utils/cbor');
      const cbor = encode({
        events: [{
          type: 'invalid',
          data: {},
          proof: [],
        }],
      });
      expect(() => parseEventLogCbor(cbor)).toThrow('Invalid entry type');
    });

    test('throws on missing proof array', () => {
      const { encode } = require('../../../src/utils/cbor');
      const cbor = encode({
        events: [{
          type: 'create',
          data: {},
        }],
      });
      expect(() => parseEventLogCbor(cbor)).toThrow('Invalid entry: proof must be an array');
    });

    test('throws on invalid proof structure', () => {
      const { encode } = require('../../../src/utils/cbor');
      const cbor = encode({
        events: [{
          type: 'create',
          data: {},
          proof: [{
            type: 'DataIntegrityProof',
            // missing required fields
          }],
        }],
      });
      expect(() => parseEventLogCbor(cbor)).toThrow('Invalid proof: missing or invalid cryptosuite');
    });
  });

  describe('Round-trip serialization', () => {
    test('serialize then parse equals original (simple log)', async () => {
      const original = await createEventLog({ name: 'Test Asset', value: 42 }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(original);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events.length).toBe(original.events.length);
      expect(parsed.events[0].type).toBe(original.events[0].type);
      expect(parsed.events[0].data).toEqual(original.events[0].data);
      expect(parsed.events[0].proof.length).toBe(original.events[0].proof.length);
    });

    test('serialize then parse equals original (multi-event log)', async () => {
      let original = await createEventLog({ name: 'Test Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });
      original = await updateEventLog(original, { name: 'Updated Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });
      original = await updateEventLog(original, { name: 'Final Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(original);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events.length).toBe(3);
      for (let i = 0; i < original.events.length; i++) {
        expect(parsed.events[i].type).toBe(original.events[i].type);
        expect(parsed.events[i].previousEvent).toBe(original.events[i].previousEvent);
        expect(parsed.events[i].data).toEqual(original.events[i].data);
      }
    });

    test('serialize then parse preserves previousLog', () => {
      const original: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Chunked Asset' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: 'did:key:z6Mktest#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zMockProofValue123',
          }],
        }],
        previousLog: 'uPreviousLogDigest',
      };

      const cbor = serializeEventLogCbor(original);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.previousLog).toBe(original.previousLog);
    });

    test('serialize then parse preserves complex nested data', async () => {
      const complexData = {
        name: 'Complex Asset',
        metadata: {
          tags: ['art', 'digital', 'nft'],
          dimensions: { width: 1920, height: 1080 },
          creator: {
            name: 'Artist',
            did: 'did:key:z6MkCreator',
          },
        },
        nullValue: null,
        boolValue: true,
        numValue: 3.14159,
      };

      const original = await createEventLog(complexData, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(original);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events[0].data).toEqual(complexData);
    });

    test('serialize then parse preserves witness proofs', () => {
      const original: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Witnessed Asset' },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zControllerProof',
            },
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:05Z',
              verificationMethod: 'did:btco:witness#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zWitnessProof',
              witnessedAt: '2026-01-20T12:00:05Z',
            } as WitnessProof,
          ],
        }],
      };

      const cbor = serializeEventLogCbor(original);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events[0].proof.length).toBe(2);
      const witnessProof = parsed.events[0].proof[1] as WitnessProof;
      expect(witnessProof.witnessedAt).toBe('2026-01-20T12:00:05Z');
    });

    test('double round-trip produces identical results', async () => {
      const original = await createEventLog({ name: 'Test' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor1 = serializeEventLogCbor(original);
      const parsed1 = parseEventLogCbor(cbor1);
      const cbor2 = serializeEventLogCbor(parsed1);
      const parsed2 = parseEventLogCbor(cbor2);

      // Second parse should produce identical structure
      expect(parsed2.events.length).toBe(parsed1.events.length);
      expect(parsed2.events[0].type).toBe(parsed1.events[0].type);
      expect(parsed2.events[0].data).toEqual(parsed1.events[0].data);
    });
  });

  describe('CBOR size comparison', () => {
    test('CBOR output is smaller than JSON output', async () => {
      const log = await createEventLog({ 
        name: 'Test Asset',
        description: 'A test asset with some metadata',
        tags: ['test', 'asset', 'cbor'],
      }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const json = serializeEventLogJson(log);
      const jsonBytes = new TextEncoder().encode(json);

      expect(cbor.length).toBeLessThan(jsonBytes.length);
    });

    test('CBOR is smaller for multi-event logs', async () => {
      let log = await createEventLog({ name: 'Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });
      for (let i = 0; i < 5; i++) {
        log = await updateEventLog(log, { name: `Asset v${i + 2}`, version: i + 2 }, {
          signer: mockSigner,
          verificationMethod: 'did:key:z6Mktest#key-1',
        });
      }

      const cbor = serializeEventLogCbor(log);
      const json = serializeEventLogJson(log);
      const jsonBytes = new TextEncoder().encode(json);

      expect(cbor.length).toBeLessThan(jsonBytes.length);
      // CBOR should be significantly smaller (at least 30% reduction typically)
      const reduction = 1 - (cbor.length / jsonBytes.length);
      expect(reduction).toBeGreaterThan(0.2); // At least 20% smaller
    });

    test('CBOR is smaller for complex nested data', async () => {
      const log = await createEventLog({
        name: 'Complex Asset',
        metadata: {
          tags: ['art', 'digital', 'nft', 'collectible'],
          dimensions: { width: 1920, height: 1080, depth: 24 },
          creator: {
            name: 'Artist Name',
            did: 'did:key:z6MkCreator123456789',
            website: 'https://artist.example.com',
          },
          attributes: [
            { trait: 'Background', value: 'Blue' },
            { trait: 'Style', value: 'Abstract' },
            { trait: 'Rarity', value: 'Legendary' },
          ],
        },
        resources: [
          { url: 'ipfs://QmHash1', type: 'image/png' },
          { url: 'ipfs://QmHash2', type: 'video/mp4' },
        ],
      }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const json = serializeEventLogJson(log);
      const jsonBytes = new TextEncoder().encode(json);

      expect(cbor.length).toBeLessThan(jsonBytes.length);
    });
  });

  describe('Edge cases', () => {
    test('handles empty data object', async () => {
      const log = await createEventLog({}, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events[0].data).toEqual({});
    });

    test('handles unicode in data', async () => {
      const log = await createEventLog({ name: '日本語テスト 🎨 émojis' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect((parsed.events[0].data as { name: string }).name).toBe('日本語テスト 🎨 émojis');
    });

    test('handles large numbers', async () => {
      const log = await createEventLog({ 
        bigInt: 9007199254740991, // Number.MAX_SAFE_INTEGER
        negBigInt: -9007199254740991,
        float: 0.123456789012345,
      }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);
      const data = parsed.events[0].data as { bigInt: number; negBigInt: number; float: number };

      expect(data.bigInt).toBe(9007199254740991);
      expect(data.negBigInt).toBe(-9007199254740991);
      expect(data.float).toBeCloseTo(0.123456789012345);
    });

    test('handles array in data', async () => {
      const log = await createEventLog({ 
        items: [1, 2, 3],
        mixed: [1, 'two', { three: 3 }],
      }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);
      const data = parsed.events[0].data as { items: number[]; mixed: unknown[] };

      expect(data.items).toEqual([1, 2, 3]);
      expect(data.mixed).toEqual([1, 'two', { three: 3 }]);
    });

    test('handles deactivate event type', () => {
      const log: EventLog = {
        events: [
          {
            type: 'create',
            data: { name: 'Test' },
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T12:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zProof1',
            }],
          },
          {
            type: 'deactivate',
            data: { reason: 'No longer needed', deactivatedAt: '2026-01-20T13:00:00Z' },
            previousEvent: 'uHash123',
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: '2026-01-20T13:00:00Z',
              verificationMethod: 'did:key:z6Mktest#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zProof2',
            }],
          },
        ],
      };

      const cbor = serializeEventLogCbor(log);
      const parsed = parseEventLogCbor(cbor);

      expect(parsed.events[1].type).toBe('deactivate');
      expect((parsed.events[1].data as { reason: string }).reason).toBe('No longer needed');
    });
  });
});
