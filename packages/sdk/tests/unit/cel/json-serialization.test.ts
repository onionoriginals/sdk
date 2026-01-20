import { describe, test, expect } from 'bun:test';
import { serializeEventLogJson, parseEventLogJson } from '../../../src/cel/serialization/json';
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

describe('CEL JSON Serialization', () => {
  describe('serializeEventLogJson', () => {
    test('serializes a simple event log to JSON string', async () => {
      const log = await createEventLog({ name: 'Test Asset' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(log);

      expect(typeof json).toBe('string');
      expect(json.includes('"events"')).toBe(true);
      expect(json.includes('"Test Asset"')).toBe(true);
    });

    test('produces valid JSON', async () => {
      const log = await createEventLog({ name: 'Test' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(log);

      // Should not throw
      const parsed = JSON.parse(json);
      expect(parsed).toBeDefined();
      expect(parsed.events).toBeDefined();
    });

    test('uses deterministic key ordering', async () => {
      const log = await createEventLog({ z: 'last', a: 'first', m: 'middle' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(log);
      const parsed = JSON.parse(json);

      // Keys should be sorted alphabetically in the data
      const dataKeys = Object.keys(parsed.events[0].data);
      expect(dataKeys).toEqual(['a', 'm', 'z']);
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

      const json = serializeEventLogJson(log);
      const parsed = JSON.parse(json);

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

      const json = serializeEventLogJson(log);
      const parsed = JSON.parse(json);

      expect(parsed.previousLog).toBe('uPreviousLogHash123');
    });

    test('throws on null input', () => {
      expect(() => serializeEventLogJson(null as unknown as EventLog)).toThrow('Cannot serialize null or undefined EventLog');
    });

    test('throws on undefined input', () => {
      expect(() => serializeEventLogJson(undefined as unknown as EventLog)).toThrow('Cannot serialize null or undefined EventLog');
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

      const json = serializeEventLogJson(log);
      const parsed = JSON.parse(json);

      expect(parsed.events[0].proof[1].witnessedAt).toBe('2026-01-20T12:00:01Z');
    });
  });

  describe('parseEventLogJson', () => {
    test('parses a valid JSON string to EventLog', () => {
      const json = JSON.stringify({
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
      });

      const log = parseEventLogJson(json);

      expect(log.events.length).toBe(1);
      expect(log.events[0].type).toBe('create');
      expect((log.events[0].data as { name: string }).name).toBe('Test Asset');
    });

    test('parses log with multiple events', () => {
      const json = JSON.stringify({
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
      });

      const log = parseEventLogJson(json);

      expect(log.events.length).toBe(2);
      expect(log.events[0].type).toBe('create');
      expect(log.events[1].type).toBe('update');
      expect(log.events[1].previousEvent).toBe('uHashOfPreviousEvent');
    });

    test('parses previousLog field', () => {
      const json = JSON.stringify({
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
      });

      const log = parseEventLogJson(json);

      expect(log.previousLog).toBe('uChunkHash123');
    });

    test('parses witness proofs correctly', () => {
      const json = JSON.stringify({
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
            },
          ],
        }],
      });

      const log = parseEventLogJson(json);
      const witnessProof = log.events[0].proof[1] as WitnessProof;

      expect(witnessProof.witnessedAt).toBe('2026-01-20T12:00:01Z');
    });

    test('throws on invalid JSON', () => {
      expect(() => parseEventLogJson('not valid json {')).toThrow('Invalid JSON');
    });

    test('throws on null input', () => {
      expect(() => parseEventLogJson(null as unknown as string)).toThrow('Cannot parse null, undefined, or non-string value');
    });

    test('throws on undefined input', () => {
      expect(() => parseEventLogJson(undefined as unknown as string)).toThrow('Cannot parse null, undefined, or non-string value');
    });

    test('throws on non-object JSON', () => {
      expect(() => parseEventLogJson('"just a string"')).toThrow('Invalid EventLog: must be an object');
    });

    test('throws on missing events array', () => {
      expect(() => parseEventLogJson('{}')).toThrow('Invalid EventLog: events must be an array');
    });

    test('throws on invalid event type', () => {
      const json = JSON.stringify({
        events: [{
          type: 'invalid',
          data: {},
          proof: [],
        }],
      });

      expect(() => parseEventLogJson(json)).toThrow('Invalid entry type');
    });

    test('throws on missing proof array', () => {
      const json = JSON.stringify({
        events: [{
          type: 'create',
          data: {},
        }],
      });

      expect(() => parseEventLogJson(json)).toThrow('Invalid entry: proof must be an array');
    });

    test('throws on invalid proof structure', () => {
      const json = JSON.stringify({
        events: [{
          type: 'create',
          data: {},
          proof: [{
            type: 'DataIntegrityProof',
            // missing required fields
          }],
        }],
      });

      expect(() => parseEventLogJson(json)).toThrow('Invalid proof: missing or invalid cryptosuite');
    });
  });

  describe('Round-trip serialization', () => {
    test('serialize then parse equals original (simple log)', async () => {
      const original = await createEventLog({ name: 'Test Asset', value: 42 }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(original);
      const parsed = parseEventLogJson(json);

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

      const json = serializeEventLogJson(original);
      const parsed = parseEventLogJson(json);

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

      const json = serializeEventLogJson(original);
      const parsed = parseEventLogJson(json);

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

      const json = serializeEventLogJson(original);
      const parsed = parseEventLogJson(json);

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

      const json = serializeEventLogJson(original);
      const parsed = parseEventLogJson(json);

      expect(parsed.events[0].proof.length).toBe(2);
      const witnessProof = parsed.events[0].proof[1] as WitnessProof;
      expect(witnessProof.witnessedAt).toBe('2026-01-20T12:00:05Z');
    });

    test('double round-trip produces identical results', async () => {
      const original = await createEventLog({ name: 'Test' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json1 = serializeEventLogJson(original);
      const parsed1 = parseEventLogJson(json1);
      const json2 = serializeEventLogJson(parsed1);
      const parsed2 = parseEventLogJson(json2);

      // Second serialization should produce identical JSON
      expect(json2).toBe(json1);
      expect(parsed2).toEqual(parsed1);
    });
  });

  describe('Edge cases', () => {
    test('handles empty data object', async () => {
      const log = await createEventLog({}, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(log);
      const parsed = parseEventLogJson(json);

      expect(parsed.events[0].data).toEqual({});
    });

    test('handles unicode in data', async () => {
      const log = await createEventLog({ name: '日本語テスト 🎨 émojis' }, {
        signer: mockSigner,
        verificationMethod: 'did:key:z6Mktest#key-1',
      });

      const json = serializeEventLogJson(log);
      const parsed = parseEventLogJson(json);

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

      const json = serializeEventLogJson(log);
      const parsed = parseEventLogJson(json);
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

      const json = serializeEventLogJson(log);
      const parsed = parseEventLogJson(json);
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

      const json = serializeEventLogJson(log);
      const parsed = parseEventLogJson(json);

      expect(parsed.events[1].type).toBe('deactivate');
      expect((parsed.events[1].data as { reason: string }).reason).toBe('No longer needed');
    });
  });
});
