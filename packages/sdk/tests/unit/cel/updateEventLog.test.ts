import { describe, test, expect } from 'bun:test';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import type { DataIntegrityProof, EventLog, CreateOptions, UpdateOptions } from '../../../src/cel/types';

/**
 * Mock signer that creates a valid DataIntegrityProof structure.
 * In production, this would use actual Ed25519 signing with eddsa-jcs-2022.
 */
function createMockSigner(verificationMethod: string) {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + Buffer.from('mock-signature-' + JSON.stringify(data)).toString('base64'),
    };
  };
}

/**
 * Helper to serialize a LogEntry for hash comparison
 */
function serializeEntry(entry: { type: string; data: unknown; previousEvent?: string; proof: DataIntegrityProof[] }): Uint8Array {
  const json = JSON.stringify(entry, Object.keys(entry).sort());
  return new TextEncoder().encode(json);
}

describe('updateEventLog', () => {
  const verificationMethod = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  describe('basic functionality', () => {
    test('appends an update event to existing log', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Initial' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Updated' }, updateOptions);
      
      expect(updatedLog.events).toHaveLength(2);
      expect(updatedLog.events[1].type).toBe('update');
    });

    test('update event has type "update"', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog.events[1].type).toBe('update');
    });

    test('update event contains the provided data', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Initial' }, createOptions);
      const updateData = { name: 'New Name', version: 2, metadata: { key: 'value' } };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, updateData, updateOptions);
      
      expect(updatedLog.events[1].data).toEqual(updateData);
    });
  });

  describe('hash chain linking', () => {
    test('update event has previousEvent field', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog.events[1].previousEvent).toBeDefined();
      expect(typeof updatedLog.events[1].previousEvent).toBe('string');
    });

    test('previousEvent matches digestMultibase of last event', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const lastEvent = initialLog.events[0];
      const expectedHash = computeDigestMultibase(serializeEntry(lastEvent));
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog.events[1].previousEvent).toBe(expectedHash);
    });

    test('hash chain links correctly across multiple updates', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      // Create initial log
      const log1 = await createEventLog({ version: 1 }, createOptions);
      
      // First update
      const log2 = await updateEventLog(log1, { version: 2 }, updateOptions);
      
      // Second update
      const log3 = await updateEventLog(log2, { version: 3 }, updateOptions);
      
      // Verify chain integrity
      expect(log3.events).toHaveLength(3);
      
      // First event has no previousEvent
      expect(log3.events[0].previousEvent).toBeUndefined();
      
      // Second event links to first
      const expectedHash1 = computeDigestMultibase(serializeEntry(log3.events[0]));
      expect(log3.events[1].previousEvent).toBe(expectedHash1);
      
      // Third event links to second
      const expectedHash2 = computeDigestMultibase(serializeEntry(log3.events[1]));
      expect(log3.events[2].previousEvent).toBe(expectedHash2);
    });
  });

  describe('immutability', () => {
    test('does not mutate the input log', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const initialEventsCount = initialLog.events.length;
      const initialEventsCopy = [...initialLog.events];
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      // Verify original log was not mutated
      expect(initialLog.events.length).toBe(initialEventsCount);
      expect(initialLog.events).toEqual(initialEventsCopy);
    });

    test('returns a new EventLog instance', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog).not.toBe(initialLog);
      expect(updatedLog.events).not.toBe(initialLog.events);
    });
  });

  describe('proof generation', () => {
    test('update event has at least one proof', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog.events[1].proof).toBeInstanceOf(Array);
      expect(updatedLog.events[1].proof.length).toBeGreaterThanOrEqual(1);
    });

    test('proof uses eddsa-jcs-2022 cryptosuite', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      const proof = updatedLog.events[1].proof[0];
      
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    test('proof includes verificationMethod', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, { name: 'Changed' }, updateOptions);
      const proof = updatedLog.events[1].proof[0];
      
      expect(proof.verificationMethod).toBe(verificationMethod);
    });
  });

  describe('error handling', () => {
    test('throws error when updating empty log', async () => {
      const emptyLog: EventLog = { events: [] };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      await expect(updateEventLog(emptyLog, { name: 'Test' }, updateOptions)).rejects.toThrow('Cannot update an empty event log');
    });

    test('throws error when signer returns invalid proof', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const invalidSigner = async (): Promise<DataIntegrityProof> => {
        return {
          type: '',
          cryptosuite: '',
          created: '',
          verificationMethod: '',
          proofPurpose: '',
          proofValue: '',
        };
      };
      
      const updateOptions: UpdateOptions = {
        signer: invalidSigner,
        verificationMethod,
      };
      
      await expect(updateEventLog(initialLog, { name: 'Changed' }, updateOptions)).rejects.toThrow('Invalid proof');
    });
  });

  describe('previousLog preservation', () => {
    test('preserves previousLog reference when it exists', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      // Simulate a chunked log with previousLog reference
      const chunkedLog: EventLog = {
        ...initialLog,
        previousLog: 'uABC123previousLogHash',
      };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(chunkedLog, { name: 'Changed' }, updateOptions);
      
      expect(updatedLog.previousLog).toBe('uABC123previousLogHash');
    });
  });

  describe('data preservation', () => {
    test('handles complex nested update data', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Initial' }, createOptions);
      
      const complexUpdateData = {
        name: 'Updated Asset',
        resources: [
          { url: ['https://new.example.com/image.png'], mediaType: 'image/png', digestMultibase: 'uNEW123' },
        ],
        metadata: {
          version: 2,
          changelog: ['Added new image'],
          nested: { deep: { value: true } },
        },
      };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updatedLog = await updateEventLog(initialLog, complexUpdateData, updateOptions);
      
      expect(updatedLog.events[1].data).toEqual(complexUpdateData);
    });
  });
});
