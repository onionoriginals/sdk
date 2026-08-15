/**
 * appendEvent Algorithm
 *
 * Generic append for typed CEL events. The signed payload is exactly
 * { type, data, previousEvent } — the shape verifyEventLog reconstructs —
 * and the chain link is the digest of the previous entry (proof excluded).
 *
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, EventType, LogEntry, UpdateOptions, DataIntegrityProof } from '../types.js';
import { computeDigestMultibase } from '../hash.js';
import { canonicalizeEntryForChain } from '../canonicalize.js';
import { sealProof } from './sealProof.js';

/**
 * Appends a typed event to an existing Cryptographic Event Log.
 *
 * The new event is cryptographically linked to the previous event
 * via a hash of the last event (previousEvent field).
 *
 * @param log - The existing event log to append to
 * @param type - The event type (any type except "create")
 * @param data - The event data (schema varies by event type)
 * @param options - Signing options including signer function and verification method
 * @returns A new EventLog with the event appended (input is not mutated)
 */
export async function appendEvent(
  log: EventLog,
  type: Exclude<EventType, 'create'>,
  data: unknown,
  options: UpdateOptions
): Promise<EventLog> {
  const { signer } = options;

  if ((type as EventType) === 'create') {
    throw new Error('appendEvent cannot append a create event; use createEventLog');
  }

  // Validate input log
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot append to an empty event log');
  }

  // Get the last event to compute the hash chain link
  const lastEvent = log.events[log.events.length - 1];

  // Compute the digestMultibase of the last event
  const previousEvent = computeDigestMultibase(canonicalizeEntryForChain(lastEvent));

  // Create the event structure without proof first
  const eventBase = {
    type,
    data,
    previousEvent,
  };

  // Generate the proof and prove it verifies before sealing it (see sealProof).
  const proof: DataIntegrityProof = await sealProof(signer, eventBase, options);

  // Construct the complete log entry
  const entry: LogEntry = {
    type,
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
