/**
 * CBOR Serialization for CEL Event Logs
 * 
 * Provides compact binary serialization and parsing of EventLog objects using CBOR format.
 * CBOR provides ~50% size reduction compared to JSON for bandwidth-sensitive applications.
 */

import type { EventLog, LogEntry, DataIntegrityProof, WitnessProof } from '../types.js';
import { encode, decode } from '../../utils/cbor.js';

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
  // `created` is optional per the DataIntegrityProof type and the creation path
  // (createEventLog does not require it). Only validate it when present.
  if (p.created !== undefined && typeof p.created !== 'string') {
    throw new Error('Invalid proof: created must be a string');
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
  
  // Preserve any extension fields (e.g. Bitcoin witness anchors
  // txid/satoshi/inscriptionId/blockHeight, proof-chain id/previousProof) by
  // carrying through every key on the source object. The known required fields
  // are re-assigned after validation so their types are narrowed correctly and
  // an `undefined` `created` is not introduced.
  const baseProof = {
    ...p,
    type: p.type,
    cryptosuite: p.cryptosuite,
    verificationMethod: p.verificationMethod,
    proofPurpose: p.proofPurpose,
    proofValue: p.proofValue,
  } as DataIntegrityProof;
  if (typeof p.created === 'string') {
    baseProof.created = p.created;
  }

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
  if (e.type !== 'create' && e.type !== 'update' && e.type !== 'deactivate' && e.type !== 'migrate' && e.type !== 'transfer' && e.type !== 'rotateKey') {
    throw new Error(`Invalid entry type: ${e.type}`);
  }
  
  // Validate proof array
  if (!Array.isArray(e.proof)) {
    throw new Error('Invalid entry: proof must be an array');
  }

  // `data` is a required field on LogEntry. Use a presence check (not a
  // truthiness/undefined check) so an explicit falsy or null payload is
  // preserved while a genuinely absent key is rejected.
  if (!('data' in e)) {
    throw new Error('Invalid entry: missing required data field');
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
 * Serialize an EventLog to CBOR binary format.
 * 
 * CBOR provides a compact binary representation that is typically
 * 30-50% smaller than JSON for event logs.
 * 
 * @param log - The EventLog to serialize
 * @returns Uint8Array containing the CBOR-encoded EventLog
 * @throws Error if log is null or undefined
 * 
 * @example
 * ```typescript
 * const log = await createEventLog(data, options);
 * const cbor = serializeEventLogCbor(log);
 * console.log(cbor.length); // compact binary size
 * ```
 */
export function serializeEventLogCbor(log: EventLog): Uint8Array {
  if (!log) {
    throw new Error('Cannot serialize null or undefined EventLog');
  }
  
  return encode(log);
}

/**
 * Parse a CBOR binary into an EventLog.
 * 
 * Validates the structure and types of the parsed object.
 * 
 * @param cbor - CBOR binary data to parse
 * @returns Parsed and validated EventLog
 * @throws Error if CBOR is invalid or doesn't match EventLog structure
 * 
 * @example
 * ```typescript
 * const cbor = readFileSync('asset.cel.cbor');
 * const log = parseEventLogCbor(cbor);
 * console.log(log.events.length);
 * ```
 */
export function parseEventLogCbor(cbor: Uint8Array): EventLog {
  if (!cbor || !(cbor instanceof Uint8Array)) {
    throw new Error('Cannot parse null, undefined, or non-Uint8Array value');
  }
  
  if (cbor.length === 0) {
    throw new Error('Cannot parse empty CBOR data');
  }
  
  let parsed: unknown;
  try {
    parsed = decode(cbor);
  } catch (e) {
    throw new Error(`Invalid CBOR: ${(e as Error).message}`);
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
