/**
 * updateEventLog Algorithm
 * 
 * Appends an update event to an existing Cryptographic Event Log.
 * Each update event references the previous event via a hash chain.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, UpdateOptions } from '../types.js';
import { appendEvent } from './appendEvent.js';

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
  // Validate input log (preserved verbatim: message predates the generic guard in appendEvent)
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot update an empty event log');
  }
  return appendEvent(log, 'update', data, options);
}
