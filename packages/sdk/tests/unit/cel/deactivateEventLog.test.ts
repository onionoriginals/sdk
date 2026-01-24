import { describe, test, expect } from 'bun:test';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { deactivateEventLog } from '../../../src/cel/algorithms/deactivateEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import type { DataIntegrityProof, EventLog, CreateOptions, UpdateOptions, DeactivateOptions } from '../../../src/cel/types';

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

describe('deactivateEventLog', () => {
  const verificationMethod = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  describe('basic functionality', () => {
    test('appends a deactivate event to existing log', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test Asset' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Asset retired', deactivateOptions);
      
      expect(deactivatedLog.events).toHaveLength(2);
      expect(deactivatedLog.events[1].type).toBe('deactivate');
    });

    test('deactivate event has type "deactivate"', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'No longer needed', deactivateOptions);
      
      expect(deactivatedLog.events[1].type).toBe('deactivate');
    });

    test('deactivate event contains reason in data', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const reason = 'Asset superseded by new version';
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, reason, deactivateOptions);
      const eventData = deactivatedLog.events[1].data as { reason: string; deactivatedAt: string };
      
      expect(eventData.reason).toBe(reason);
    });

    test('deactivate event contains deactivatedAt timestamp', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      const eventData = deactivatedLog.events[1].data as { reason: string; deactivatedAt: string };
      
      expect(eventData.deactivatedAt).toBeDefined();
      expect(typeof eventData.deactivatedAt).toBe('string');
      // Verify it's a valid ISO timestamp
      expect(() => new Date(eventData.deactivatedAt)).not.toThrow();
    });
  });

  describe('hash chain linking', () => {
    test('deactivate event has previousEvent field', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      
      expect(deactivatedLog.events[1].previousEvent).toBeDefined();
      expect(typeof deactivatedLog.events[1].previousEvent).toBe('string');
    });

    test('previousEvent matches digestMultibase of last event', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const lastEvent = initialLog.events[0];
      const expectedHash = computeDigestMultibase(serializeEntry(lastEvent));
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      
      expect(deactivatedLog.events[1].previousEvent).toBe(expectedHash);
    });

    test('links correctly after multiple updates', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      // Create initial log
      const log1 = await createEventLog({ version: 1 }, createOptions);
      
      // Add updates
      const log2 = await updateEventLog(log1, { version: 2 }, updateOptions);
      const log3 = await updateEventLog(log2, { version: 3 }, updateOptions);
      
      // Deactivate
      const deactivatedLog = await deactivateEventLog(log3, 'Final version reached', deactivateOptions);
      
      // Verify chain integrity
      expect(deactivatedLog.events).toHaveLength(4);
      
      // Deactivate event links to last update
      const expectedHash = computeDigestMultibase(serializeEntry(log3.events[2]));
      expect(deactivatedLog.events[3].previousEvent).toBe(expectedHash);
    });
  });

  describe('sealing behavior', () => {
    test('prevents double deactivation', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'First deactivation', deactivateOptions);
      
      // Attempt to deactivate again should throw
      await expect(
        deactivateEventLog(deactivatedLog, 'Second deactivation', deactivateOptions)
      ).rejects.toThrow('Event log is already deactivated');
    });

    test('deactivate seals the log (last event is deactivate)', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const updateOptions: UpdateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const log1 = await createEventLog({ name: 'Test' }, createOptions);
      const log2 = await updateEventLog(log1, { name: 'Updated' }, updateOptions);
      const deactivatedLog = await deactivateEventLog(log2, 'Done', deactivateOptions);
      
      // Last event should be deactivate
      const lastEvent = deactivatedLog.events[deactivatedLog.events.length - 1];
      expect(lastEvent.type).toBe('deactivate');
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
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      
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
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      
      expect(deactivatedLog).not.toBe(initialLog);
      expect(deactivatedLog.events).not.toBe(initialLog.events);
    });
  });

  describe('proof generation', () => {
    test('deactivate event has at least one proof', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      
      expect(deactivatedLog.events[1].proof).toBeInstanceOf(Array);
      expect(deactivatedLog.events[1].proof.length).toBeGreaterThanOrEqual(1);
    });

    test('proof uses eddsa-jcs-2022 cryptosuite', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      const proof = deactivatedLog.events[1].proof[0];
      
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    test('proof includes verificationMethod', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, 'Retired', deactivateOptions);
      const proof = deactivatedLog.events[1].proof[0];
      
      expect(proof.verificationMethod).toBe(verificationMethod);
    });
  });

  describe('error handling', () => {
    test('throws error when deactivating empty log', async () => {
      const emptyLog: EventLog = { events: [] };
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      await expect(
        deactivateEventLog(emptyLog, 'Test', deactivateOptions)
      ).rejects.toThrow('Cannot deactivate an empty event log');
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
      
      const deactivateOptions: DeactivateOptions = {
        signer: invalidSigner,
        verificationMethod,
      };
      
      await expect(
        deactivateEventLog(initialLog, 'Retired', deactivateOptions)
      ).rejects.toThrow('Invalid proof');
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
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(chunkedLog, 'Retired', deactivateOptions);
      
      expect(deactivatedLog.previousLog).toBe('uABC123previousLogHash');
    });
  });

  describe('reason handling', () => {
    test('handles empty reason string', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, '', deactivateOptions);
      const eventData = deactivatedLog.events[1].data as { reason: string };
      
      expect(eventData.reason).toBe('');
    });

    test('handles long reason string', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const longReason = 'This is a very long deactivation reason that explains in great detail why this asset is being retired. '.repeat(10);
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, longReason, deactivateOptions);
      const eventData = deactivatedLog.events[1].data as { reason: string };
      
      expect(eventData.reason).toBe(longReason);
    });

    test('handles special characters in reason', async () => {
      const createOptions: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const initialLog = await createEventLog({ name: 'Test' }, createOptions);
      const specialReason = 'Reason with "quotes", \'apostrophes\', <tags>, & unicode: 日本語 🎉';
      
      const deactivateOptions: DeactivateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };
      
      const deactivatedLog = await deactivateEventLog(initialLog, specialReason, deactivateOptions);
      const eventData = deactivatedLog.events[1].data as { reason: string };
      
      expect(eventData.reason).toBe(specialReason);
    });
  });
});
