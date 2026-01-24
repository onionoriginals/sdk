/**
 * JSON Serialization for CEL Event Logs
 * 
 * Provides serialization and parsing of EventLog objects to/from JSON format.
 * Uses deterministic key ordering for consistent hashes.
 */

import type { EventLog, LogEntry, DataIntegrityProof, WitnessProof } from '../types';

/**
 * Sort object keys recursively for deterministic JSON output.
 * This ensures consistent serialization for hash computations.
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  
  return obj;
}

/**
 * Serialize an EventLog to JSON string.
 * 
 * Uses deterministic key ordering for consistent output.
 * 
 * @param log - The EventLog to serialize
 * @returns JSON string representation of the EventLog
 * @throws Error if log is null or undefined
 * 
 * @example
 * ```typescript
 * const log = await createEventLog(data, options);
 * const json = serializeEventLogJson(log);
 * console.log(json); // '{"events":[...]}'
 * ```
 */
export function serializeEventLogJson(log: EventLog): string {
  if (!log) {
    throw new Error('Cannot serialize null or undefined EventLog');
  }
  
  const sorted = sortKeys(log);
  return JSON.stringify(sorted, null, 2);
}

/**
 * Check if a proof object is a WitnessProof (has witnessedAt field)
 */
function isWitnessProof(proof: DataIntegrityProof | WitnessProof): proof is WitnessProof {
  return 'witnessedAt' in proof && typeof (proof as WitnessProof).witnessedAt === 'string';
}

/**
 * Validate and reconstruct a DataIntegrityProof or WitnessProof
 */
function parseProof(proof: unknown): DataIntegrityProof | WitnessProof {
  if (!proof || typeof proof !== 'object') {
    throw new Error('Invalid proof: must be an object');
  }
  
  const p = proof as Record<string, unknown>;
  
  // Validate required DataIntegrityProof fields
  if (typeof p.type !== 'string') {
    throw new Error('Invalid proof: missing or invalid type');
  }
  if (typeof p.cryptosuite !== 'string') {
    throw new Error('Invalid proof: missing or invalid cryptosuite');
  }
  if (typeof p.created !== 'string') {
    throw new Error('Invalid proof: missing or invalid created');
  }
  if (typeof p.verificationMethod !== 'string') {
    throw new Error('Invalid proof: missing or invalid verificationMethod');
  }
  if (typeof p.proofPurpose !== 'string') {
    throw new Error('Invalid proof: missing or invalid proofPurpose');
  }
  if (typeof p.proofValue !== 'string') {
    throw new Error('Invalid proof: missing or invalid proofValue');
  }
  
  const baseProof: DataIntegrityProof = {
    type: p.type,
    cryptosuite: p.cryptosuite,
    created: p.created,
    verificationMethod: p.verificationMethod,
    proofPurpose: p.proofPurpose,
    proofValue: p.proofValue,
  };
  
  // Check for WitnessProof
  if ('witnessedAt' in p) {
    if (typeof p.witnessedAt !== 'string') {
      throw new Error('Invalid witness proof: witnessedAt must be a string');
    }
    return {
      ...baseProof,
      witnessedAt: p.witnessedAt,
    } as WitnessProof;
  }
  
  return baseProof;
}

/**
 * Validate and reconstruct a LogEntry
 */
function parseEntry(entry: unknown): LogEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid entry: must be an object');
  }
  
  const e = entry as Record<string, unknown>;
  
  // Validate type
  if (e.type !== 'create' && e.type !== 'update' && e.type !== 'deactivate') {
    throw new Error(`Invalid entry type: ${e.type}`);
  }
  
  // Validate proof array
  if (!Array.isArray(e.proof)) {
    throw new Error('Invalid entry: proof must be an array');
  }
  
  const parsedEntry: LogEntry = {
    type: e.type,
    data: e.data,
    proof: e.proof.map(parseProof),
  };
  
  // Optional previousEvent
  if (e.previousEvent !== undefined) {
    if (typeof e.previousEvent !== 'string') {
      throw new Error('Invalid entry: previousEvent must be a string');
    }
    parsedEntry.previousEvent = e.previousEvent;
  }
  
  return parsedEntry;
}

/**
 * Parse a JSON string into an EventLog.
 * 
 * Validates the structure and types of the parsed object.
 * 
 * @param json - JSON string to parse
 * @returns Parsed and validated EventLog
 * @throws Error if JSON is invalid or doesn't match EventLog structure
 * 
 * @example
 * ```typescript
 * const json = '{"events":[...]}';
 * const log = parseEventLogJson(json);
 * console.log(log.events.length);
 * ```
 */
export function parseEventLogJson(json: string): EventLog {
  if (!json || typeof json !== 'string') {
    throw new Error('Cannot parse null, undefined, or non-string value');
  }
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid EventLog: must be an object');
  }
  
  const obj = parsed as Record<string, unknown>;
  
  // Validate events array
  if (!Array.isArray(obj.events)) {
    throw new Error('Invalid EventLog: events must be an array');
  }
  
  const eventLog: EventLog = {
    events: obj.events.map(parseEntry),
  };
  
  // Optional previousLog
  if (obj.previousLog !== undefined) {
    if (typeof obj.previousLog !== 'string') {
      throw new Error('Invalid EventLog: previousLog must be a string');
    }
    eventLog.previousLog = obj.previousLog;
  }
  
  return eventLog;
}
