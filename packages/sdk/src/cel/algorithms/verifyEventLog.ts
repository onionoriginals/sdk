/**
 * verifyEventLog Algorithm
 * 
 * Verifies all proofs and hash chain integrity in a Cryptographic Event Log.
 * Returns detailed per-event verification status.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { 
  EventLog, 
  LogEntry, 
  VerifyOptions, 
  VerificationResult, 
  EventVerification,
  DataIntegrityProof 
} from '../types';
import { computeDigestMultibase } from '../hash';

/**
 * Serializes data to JCS (JSON Canonicalization Scheme) format.
 * Uses JSON with sorted keys for deterministic serialization.
 * 
 * @param data - The data to serialize
 * @returns UTF-8 encoded bytes
 */
function serializeToJcs(data: unknown): Uint8Array {
  // JCS uses JSON with lexicographically sorted keys
  const json = JSON.stringify(data, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = value[key];
        return sorted;
      }, {});
    }
    return value;
  });
  return new TextEncoder().encode(json);
}

/**
 * Serializes a LogEntry to a deterministic byte representation for hashing.
 * Uses JSON with sorted keys for reproducibility.
 * This must match the serialization used in createEventLog/updateEventLog.
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
 * Default proof verifier using eddsa-jcs-2022 cryptosuite.
 * 
 * This is a basic implementation that validates proof structure.
 * For full cryptographic verification, a custom verifier should be provided
 * that has access to the public key from the verificationMethod.
 * 
 * @param proof - The proof to verify
 * @param data - The data that was signed
 * @returns True if proof structure is valid
 */
async function defaultVerifier(proof: DataIntegrityProof, data: unknown): Promise<boolean> {
  // Validate proof has required fields
  if (!proof.type || proof.type !== 'DataIntegrityProof') {
    return false;
  }
  
  if (!proof.cryptosuite) {
    return false;
  }
  
  if (!proof.proofValue || typeof proof.proofValue !== 'string' || proof.proofValue.length === 0) {
    return false;
  }
  
  if (!proof.verificationMethod || typeof proof.verificationMethod !== 'string') {
    return false;
  }
  
  if (!proof.proofPurpose || typeof proof.proofPurpose !== 'string') {
    return false;
  }
  
  // Check for valid cryptosuite
  const validCryptosuites = ['eddsa-jcs-2022', 'eddsa-rdfc-2022'];
  if (!validCryptosuites.includes(proof.cryptosuite)) {
    return false;
  }
  
  // Validate proofValue is properly formatted (multibase encoded)
  // Most proofValues start with 'z' (base58btc) or 'u' (base64url)
  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) {
    return false;
  }
  
  return true;
}

/**
 * Verifies the hash chain for a single event.
 * 
 * @param event - The current event to verify
 * @param index - The index of the event in the log
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @returns Object with chainValid boolean and any errors
 */
function verifyChain(
  event: LogEntry,
  index: number,
  previousEvent: LogEntry | undefined
): { chainValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (index === 0) {
    // First event must NOT have previousEvent
    if (event.previousEvent !== undefined) {
      errors.push(`Event ${index}: First event must not have previousEvent field`);
      return { chainValid: false, errors };
    }
  } else {
    // Subsequent events must have previousEvent that matches hash of prior event
    if (event.previousEvent === undefined) {
      errors.push(`Event ${index}: Missing previousEvent reference`);
      return { chainValid: false, errors };
    }
    
    if (!previousEvent) {
      errors.push(`Event ${index}: Cannot verify chain - previous event not provided`);
      return { chainValid: false, errors };
    }
    
    // Compute the expected hash of the previous event
    const expectedHash = computeDigestMultibase(serializeEntry(previousEvent));
    
    if (event.previousEvent !== expectedHash) {
      errors.push(`Event ${index}: Hash chain broken - previousEvent does not match hash of prior event`);
      return { chainValid: false, errors };
    }
  }
  
  return { chainValid: true, errors: [] };
}

/**
 * Verifies a single event's proofs.
 * 
 * @param event - The event to verify
 * @param index - The index of the event in the log
 * @param verifier - The proof verification function
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @returns EventVerification result
 */
async function verifyEvent(
  event: LogEntry,
  index: number,
  verifier: (proof: DataIntegrityProof, data: unknown) => Promise<boolean>,
  previousEvent: LogEntry | undefined
): Promise<EventVerification> {
  const errors: string[] = [];
  
  // Verify hash chain
  const chainResult = verifyChain(event, index, previousEvent);
  const chainValid = chainResult.chainValid;
  errors.push(...chainResult.errors);
  
  // Check that event has proofs
  if (!event.proof || !Array.isArray(event.proof) || event.proof.length === 0) {
    errors.push(`Event ${index}: No proofs found`);
    return {
      index,
      type: event.type,
      proofValid: false,
      chainValid,
      errors,
    };
  }
  
  // Verify each proof
  let allProofsValid = true;
  const eventData = {
    type: event.type,
    data: event.data,
    ...(event.previousEvent ? { previousEvent: event.previousEvent } : {}),
  };
  
  for (let proofIndex = 0; proofIndex < event.proof.length; proofIndex++) {
    const proof = event.proof[proofIndex];
    
    try {
      const isValid = await verifier(proof, eventData);
      if (!isValid) {
        allProofsValid = false;
        errors.push(`Event ${index}, Proof ${proofIndex}: Verification failed`);
      }
    } catch (error) {
      allProofsValid = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Event ${index}, Proof ${proofIndex}: ${message}`);
    }
  }
  
  return {
    index,
    type: event.type,
    proofValid: allProofsValid,
    chainValid,
    errors,
  };
}

/**
 * Verifies all proofs and hash chain integrity in an event log.
 * 
 * This algorithm verifies:
 * - Each event has at least one proof
 * - Each proof is structurally valid (type, cryptosuite, proofValue, verificationMethod, proofPurpose)
 * - Proofs use valid cryptosuite (eddsa-jcs-2022 or eddsa-rdfc-2022)
 * - The first event has no previousEvent field
 * - Each subsequent event's previousEvent matches the digestMultibase of the prior event
 * 
 * For full cryptographic verification, provide a custom verifier function
 * in the options that can resolve the public key from the verificationMethod.
 * 
 * @param log - The event log to verify
 * @param options - Optional verification options including custom verifier
 * @returns VerificationResult with detailed per-event status including chainValid
 * 
 * @example
 * ```typescript
 * // Basic structural and chain verification
 * const result = await verifyEventLog(eventLog);
 * if (result.verified) {
 *   console.log('All proofs are valid and hash chain is intact');
 * }
 * 
 * // With custom cryptographic verifier
 * const result = await verifyEventLog(eventLog, {
 *   verifier: async (proof, data) => {
 *     // Resolve public key and verify signature
 *     const publicKey = await resolvePublicKey(proof.verificationMethod);
 *     return verifyEdDsaSignature(data, proof.proofValue, publicKey);
 *   }
 * });
 * ```
 */
export async function verifyEventLog(
  log: EventLog,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const errors: string[] = [];
  const eventVerifications: EventVerification[] = [];
  
  // Use custom verifier if provided, otherwise use default
  const verifier = options?.verifier ?? defaultVerifier;
  
  // Validate log structure
  if (!log || !log.events) {
    return {
      verified: false,
      errors: ['Invalid event log: missing events array'],
      events: [],
    };
  }
  
  if (!Array.isArray(log.events)) {
    return {
      verified: false,
      errors: ['Invalid event log: events is not an array'],
      events: [],
    };
  }
  
  if (log.events.length === 0) {
    return {
      verified: false,
      errors: ['Invalid event log: empty events array'],
      events: [],
    };
  }
  
  // Verify each event's proofs and hash chain
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const previousEvent = i > 0 ? log.events[i - 1] : undefined;
    const eventResult = await verifyEvent(event, i, verifier, previousEvent);
    eventVerifications.push(eventResult);
    
    if (!eventResult.proofValid || !eventResult.chainValid) {
      errors.push(...eventResult.errors);
    }
  }
  
  // Determine overall verification status (both proofs AND chain must be valid)
  const allProofsValid = eventVerifications.every(ev => ev.proofValid);
  const allChainsValid = eventVerifications.every(ev => ev.chainValid);
  
  return {
    verified: allProofsValid && allChainsValid,
    errors,
    events: eventVerifications,
  };
}
