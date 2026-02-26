/**
 * updateEventLog Algorithm
 */

import type { EventLog, LogEntry, UpdateOptions, DataIntegrityProof, V11EventPayload } from '../types';
import { computeDigestMultibase } from '../hash';

const REQUIRED_V11_CRYPTOSUITE = 'eddsa-jcs-2022';

function serializeEntry(entry: LogEntry): Uint8Array {
  const json = JSON.stringify(entry, Object.keys(entry).sort());
  return new TextEncoder().encode(json);
}

function normalizeUpdatePayload(data: unknown): V11EventPayload {
  const base = (typeof data === 'object' && data !== null) ? data as Record<string, unknown> : { value: data };
  return {
    ...base,
    operation: 'ResourceUpdated',
  };
}

export async function updateEventLog(
  log: EventLog,
  data: unknown,
  options: UpdateOptions
): Promise<EventLog> {
  const { signer } = options;

  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot update an empty event log');
  }

  const lastEvent = log.events[log.events.length - 1];
  const previousEvent = computeDigestMultibase(serializeEntry(lastEvent));
  const normalizedData = normalizeUpdatePayload(data);

  const eventBase = {
    type: 'update' as const,
    data: normalizedData,
    previousEvent,
  };

  const proof: DataIntegrityProof = await signer(eventBase);

  if (!proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new Error('Invalid proof: missing required fields (type, cryptosuite, proofValue)');
  }

  if (proof.cryptosuite !== REQUIRED_V11_CRYPTOSUITE) {
    throw new Error(`Invalid proof cryptosuite for required event: expected ${REQUIRED_V11_CRYPTOSUITE}`);
  }

  const entry: LogEntry = {
    type: 'update',
    data: normalizedData,
    previousEvent,
    proof: [proof],
  };

  const eventLog: EventLog = {
    events: [...log.events, entry],
    ...(log.previousLog ? { previousLog: log.previousLog } : {}),
  };

  return eventLog;
}
