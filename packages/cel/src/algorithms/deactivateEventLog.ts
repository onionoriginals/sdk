/**
 * deactivateEventLog Algorithm
 * 
 * Seals an event log with a "deactivate" event. Once deactivated,
 * no further events should be added to the log.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, DeactivateOptions } from '../types.js';
import { appendEvent } from './appendEvent.js';

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
  // Validate input log
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot deactivate an empty event log');
  }

  // Check if log is already deactivated
  const lastEvent = log.events[log.events.length - 1];
  if (lastEvent.type === 'deactivate') {
    throw new Error('Event log is already deactivated');
  }

  // Deactivation data includes the reason
  const deactivationData = {
    reason,
    deactivatedAt: new Date().toISOString(),
  };

  return appendEvent(log, 'deactivate', deactivationData, options);
}
