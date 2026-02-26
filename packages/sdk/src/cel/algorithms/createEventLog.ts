/**
 * createEventLog Algorithm
 * 
 * Creates a new Cryptographic Event Log with an initial "create" event.
 * The create event is the first event in a log and has no previousEvent reference.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, LogEntry, CreateOptions, DataIntegrityProof, V11EventPayload } from '../types';

const REQUIRED_V11_CRYPTOSUITE = 'eddsa-jcs-2022';

function normalizeCreatePayload(data: unknown): V11EventPayload {
  const base = (typeof data === 'object' && data !== null) ? data as Record<string, unknown> : { value: data };
  return {
    ...base,
    operation: 'ResourceAdded',
  };
}

/**
 * Creates a new event log with a single "create" event.
 */
export async function createEventLog(
  data: unknown,
  options: CreateOptions
): Promise<EventLog> {
  const { signer } = options;

  const normalizedData = normalizeCreatePayload(data);

  const eventBase = {
    type: 'create' as const,
    data: normalizedData,
  };

  const proof: DataIntegrityProof = await signer(eventBase);

  if (!proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new Error('Invalid proof: missing required fields (type, cryptosuite, proofValue)');
  }

  if (proof.cryptosuite !== REQUIRED_V11_CRYPTOSUITE) {
    throw new Error(`Invalid proof cryptosuite for required event: expected ${REQUIRED_V11_CRYPTOSUITE}`);
  }

  const entry: LogEntry = {
    type: 'create',
    data: normalizedData,
    proof: [proof],
  };

  const eventLog: EventLog = {
    events: [entry],
  };

  return eventLog;
}
