/**
 * updateEventLog Algorithm
 * 
 * Appends an update event to an existing Cryptographic Event Log.
 * Each update event references the previous event via a hash chain.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, LogEntry, UpdateOptions, DataIntegrityProof } from '../types';
import { computeDigestMultibase } from '../hash';

/**
 * Serializes a LogEntry to a deterministic byte representation for hashing.
 * Uses JSON with sorted keys for reproducibility.
 * 
 * @param entry - The log entry to serialize
 * @returns UTF-8 encoded bytes
 */
function serializeEntry(entry: LogEntry): Uint8Array {
  // Use JSON with sorted keys for deterministic serialization
  const json = JSON.stringify(entry, Object.keys(entry).sort());
  return new TextEncoder().encode(json);
}

/**
 * Updates an event log by appending a new "update" event.
 * 
 * The new event is cryptographically linked to the previous event
 * via a hash of the last event (previousEvent field).
 * 
 * @param log - The existing event log to update
 * @param data - The update data (e.g., modified metadata, new resources)
 * @param options - Signing options including signer function and verification method
 * @returns A new EventLog with the update event appended (input is not mutated)
 * 
 * @example
 * ```typescript
 * const updatedLog = await updateEventLog(
 *   existingLog,
 *   { name: 'Updated Asset Name', version: 2 },
 *   {
 *     signer: async (data) => createEdDsaProof(data, privateKey),
 *     verificationMethod: 'did:key:z6Mk...',
 *     proofPurpose: 'assertionMethod'
 *   }
 * );
 * ```
 */
export async function updateEventLog(
  log: EventLog,
  data: unknown,
  options: UpdateOptions
): Promise<EventLog> {
  const { signer, verificationMethod, proofPurpose = 'assertionMethod' } = options;

  // Validate input log
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot update an empty event log');
  }

  // Get the last event to compute the hash chain link
  const lastEvent = log.events[log.events.length - 1];
  
  // Compute the digestMultibase of the last event
  const previousEvent = computeDigestMultibase(serializeEntry(lastEvent));

  // Create the event structure without proof first
  const eventBase = {
    type: 'update' as const,
    data,
    previousEvent,
  };

  // Generate proof using the provided signer
  const proof: DataIntegrityProof = await signer(eventBase);

  // Validate the proof has required fields
  if (!proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new Error('Invalid proof: missing required fields (type, cryptosuite, proofValue)');
  }

  // Construct the complete log entry
  const entry: LogEntry = {
    type: 'update',
    data,
    previousEvent,
    proof: [proof],
  };

  // Return a new event log (immutable - does not mutate input)
  const eventLog: EventLog = {
    events: [...log.events, entry],
    // Preserve previousLog reference if it exists
    ...(log.previousLog ? { previousLog: log.previousLog } : {}),
  };

  return eventLog;
}
