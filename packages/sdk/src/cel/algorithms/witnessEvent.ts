/**
 * witnessEvent Algorithm
 * 
 * Adds a witness proof to an existing log entry. The witness proof is
 * appended to the event's proof array, preserving the original controller proof.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { LogEntry, WitnessProof } from '../types';
import type { WitnessService } from '../witnesses/WitnessService';
import { computeDigestMultibase } from '../hash';
import { canonicalizeEntryForChain } from '../canonicalize';

/**
 * Adds a witness proof to an event by calling a witness service.
 * 
 * The witness service attests to the event's digest and returns a proof
 * that is appended to the event's proof array. This does not replace
 * the original controller proof - it adds an additional attestation.
 * 
 * @param event - The log entry to witness
 * @param witness - The witness service to use for attestation
 * @returns A new LogEntry with the witness proof appended to the proof array
 * 
 * @example
 * ```typescript
 * const httpWitness = new HttpWitness('https://witness.example.com');
 * const witnessedEvent = await witnessEvent(myEvent, httpWitness);
 * // witnessedEvent.proof now has 2 proofs: original + witness
 * ```
 */
export async function witnessEvent(
  event: LogEntry,
  witness: WitnessService
): Promise<LogEntry> {
  // Validate inputs
  if (!event) {
    throw new Error('Event is required');
  }
  if (!event.proof || event.proof.length === 0) {
    throw new Error('Event must have at least one proof (controller proof)');
  }
  if (!witness) {
    throw new Error('Witness service is required');
  }

  // Compute digest over the *committed* fields only ({ type, data, previousEvent? }).
  // The proof array is deliberately excluded: it carries unsigned, mutable metadata
  // (created, verificationMethod, proofPurpose) and witness proofs that may be appended
  // after the fact. A witness must attest to the immutable event content, not to proof
  // metadata that could change later. This matches the hash-chain preimage used by
  // updateEventLog / deactivateEventLog / verifyEventLog. See canonicalizeEntryForChain.
  const eventBytes = canonicalizeEntryForChain(event);
  const digestMultibase = computeDigestMultibase(eventBytes);

  // Get witness proof
  const witnessProof: WitnessProof = await witness.witness(digestMultibase);

  // Validate witness proof has required fields
  if (!witnessProof.type || !witnessProof.cryptosuite || !witnessProof.proofValue) {
    throw new Error('Invalid witness proof: missing required fields (type, cryptosuite, proofValue)');
  }
  if (!witnessProof.witnessedAt) {
    throw new Error('Invalid witness proof: missing witnessedAt timestamp');
  }

  // Return new event with witness proof appended (immutable - don't modify input)
  return {
    ...event,
    proof: [...event.proof, witnessProof],
  };
}
