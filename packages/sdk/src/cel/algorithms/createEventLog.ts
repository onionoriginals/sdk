/**
 * createEventLog Algorithm
 * 
 * Creates a new Cryptographic Event Log with an initial "create" event.
 * The create event is the first event in a log and has no previousEvent reference.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { EventLog, LogEntry, CreateOptions, DataIntegrityProof } from '../types';

/**
 * Creates a new event log with a single "create" event.
 * 
 * This is the first step in creating a CEL-based provenance chain.
 * The create event establishes the initial state of an asset.
 * 
 * @param data - The initial data for the asset (e.g., name, resources, metadata)
 * @param options - Signing options including signer function and verification method
 * @returns A new EventLog containing a single create event
 * 
 * @example
 * ```typescript
 * const log = await createEventLog(
 *   { name: 'My Asset', resources: [...] },
 *   {
 *     signer: async (data) => createEdDsaProof(data, privateKey),
 *     verificationMethod: 'did:key:z6Mk...',
 *     proofPurpose: 'assertionMethod'
 *   }
 * );
 * ```
 */
export async function createEventLog(
  data: unknown,
  options: CreateOptions
): Promise<EventLog> {
  const { signer, verificationMethod, proofPurpose = 'assertionMethod' } = options;

  // Create the event structure without proof first
  const eventBase = {
    type: 'create' as const,
    data,
    // Note: First event has no previousEvent
  };

  // Generate proof using the provided signer
  const proof: DataIntegrityProof = await signer(eventBase);

  // Validate the proof has required fields
  if (!proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new Error('Invalid proof: missing required fields (type, cryptosuite, proofValue)');
  }

  // Construct the complete log entry
  const entry: LogEntry = {
    type: 'create',
    data,
    proof: [proof],
  };

  // Return the new event log
  const eventLog: EventLog = {
    events: [entry],
  };

  return eventLog;
}
