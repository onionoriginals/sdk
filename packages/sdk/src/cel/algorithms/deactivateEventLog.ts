/**
 * deactivateEventLog Algorithm
 * 
 * Seals an event log with a "deactivate" event. Once deactivated,
 * no further events should be added to the log.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, LogEntry, DeactivateOptions, DataIntegrityProof } from '../types';
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
 * Deactivates an event log by appending a final "deactivate" event.
 * 
 * The deactivate event seals the log, indicating that no further
 * events should be added. This is used to mark an asset as retired,
 * revoked, or otherwise no longer active.
 * 
 * @param log - The existing event log to deactivate
 * @param reason - The reason for deactivation (e.g., "retired", "revoked", "superseded")
 * @param options - Signing options including signer function and verification method
 * @returns A new EventLog with the deactivate event appended (input is not mutated)
 * 
 * @example
 * ```typescript
 * const deactivatedLog = await deactivateEventLog(
 *   existingLog,
 *   'Asset has been superseded by a new version',
 *   {
 *     signer: async (data) => createEdDsaProof(data, privateKey),
 *     verificationMethod: 'did:key:z6Mk...',
 *     proofPurpose: 'assertionMethod'
 *   }
 * );
 * ```
 */
export async function deactivateEventLog(
  log: EventLog,
  reason: string,
  options: DeactivateOptions
): Promise<EventLog> {
  const { signer, verificationMethod, proofPurpose = 'assertionMethod' } = options;

  // Validate input log
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot deactivate an empty event log');
  }

  // Check if log is already deactivated
  const lastEvent = log.events[log.events.length - 1];
  if (lastEvent.type === 'deactivate') {
    throw new Error('Event log is already deactivated');
  }

  // Compute the digestMultibase of the last event
  const previousEvent = computeDigestMultibase(serializeEntry(lastEvent));

  // Deactivation data includes the reason
  const deactivationData = {
    reason,
    deactivatedAt: new Date().toISOString(),
  };

  // Create the event structure without proof first
  const eventBase = {
    type: 'deactivate' as const,
    data: deactivationData,
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
    type: 'deactivate',
    data: deactivationData,
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
