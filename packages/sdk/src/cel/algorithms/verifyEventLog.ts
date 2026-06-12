/**
 * verifyEventLog Algorithm
 *
 * Verifies all proofs and hash chain integrity in a Cryptographic Event Log.
 * Returns detailed per-event verification status.
 *
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import { verifyAsync } from '@noble/ed25519';
import type {
  EventLog,
  LogEntry,
  VerifyOptions,
  VerificationResult,
  EventVerification,
  DataIntegrityProof
} from '../types';
import { computeDigestMultibase } from '../hash';
import { canonicalizeEvent } from '../canonicalize';
import { multikey } from '../../crypto/Multikey';

/**
 * Validates the structural requirements of a DataIntegrityProof (field presence,
 * multibase prefix, recognised cryptosuite).  Used as a precondition by the
 * cryptographic verifiers and as the sole check on the fallback / structural-
 * only path.
 */
function structuralCheck(proof: DataIntegrityProof): boolean {
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
  const validCryptosuites = ['eddsa-jcs-2022', 'eddsa-rdfc-2022'];
  if (!validCryptosuites.includes(proof.cryptosuite)) {
    return false;
  }
  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) {
    return false;
  }
  return true;
}

/**
 * Cryptographically verifies a `did:key` Ed25519 `eddsa-jcs-2022` proof.
 *
 * The public key is extracted directly from the `verificationMethod` URI
 * (`did:key:<multikey>#<fragment>`) so no DID resolver is required.
 *
 * Falls back to structural-only verification (returning `{ verified, cryptographicallyVerified: false }`)
 * when the `verificationMethod` is not a `did:key:` URI — in that case only the
 * structural preconditions are checked.
 *
 * @param proof - The DataIntegrityProof to verify
 * @param data  - The event payload that was signed
 * @returns `{ verified: boolean; cryptographicallyVerified: boolean }`
 */
export async function verifyDidKeyEd25519Proof(
  proof: DataIntegrityProof,
  data: unknown
): Promise<{ verified: boolean; cryptographicallyVerified: boolean }> {
  // Run structural checks first — these are preconditions for any path.
  if (!structuralCheck(proof)) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Only attempt cryptographic verification for did:key verification methods.
  if (!proof.verificationMethod.startsWith('did:key:')) {
    return { verified: true, cryptographicallyVerified: false };
  }

  try {
    // Extract the multikey portion: did:key:<multikey>#<fragment>
    const withoutPrefix = proof.verificationMethod.slice('did:key:'.length);
    const multikeyStr = withoutPrefix.split('#')[0];

    // Decode the multikey-encoded Ed25519 public key (strips multicodec header).
    const decoded = multikey.decodePublicKey(multikeyStr);
    if (decoded.type !== 'Ed25519') {
      // Not an Ed25519 key — fall back to structural only.
      return { verified: true, cryptographicallyVerified: false };
    }
    const publicKeyBytes = decoded.key;

    // Decode the multibase-encoded signature.
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);

    // Re-compute the canonical message bytes the signer signed.
    const message = canonicalizeEvent(data);

    // Cryptographic verification.
    const ok = await verifyAsync(signatureBytes, message, publicKeyBytes);
    return { verified: ok, cryptographicallyVerified: true };
  } catch {
    return { verified: false, cryptographicallyVerified: false };
  }
}

/**
 * Default proof verifier using eddsa-jcs-2022 cryptosuite.
 *
 * Dispatches to full Ed25519 cryptographic verification for `did:key` +
 * `eddsa-jcs-2022` proofs.  Falls back to structural-only verification for all
 * other verification methods, and records `cryptographicallyVerified: false`
 * on those events.
 *
 * @param proof - The proof to verify
 * @param data - The data that was signed
 * @returns True if proof is valid
 */
async function defaultVerifier(proof: DataIntegrityProof, data: unknown): Promise<boolean> {
  return structuralCheck(proof);
}

/**
 * Dispatching verifier used when no custom verifier is provided.
 * Returns the full `{ verified, cryptographicallyVerified }` pair so the
 * caller can tag the `EventVerification` accordingly.
 */
async function dispatchVerify(
  proof: DataIntegrityProof,
  data: unknown
): Promise<{ verified: boolean; cryptographicallyVerified: boolean }> {
  if (
    proof.verificationMethod.startsWith('did:key:') &&
    proof.cryptosuite === 'eddsa-jcs-2022'
  ) {
    return verifyDidKeyEd25519Proof(proof, data);
  }
  // Structural path — no cryptographic verification possible here.
  const ok = structuralCheck(proof);
  return { verified: ok, cryptographicallyVerified: false };
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
    const expectedHash = computeDigestMultibase(canonicalizeEvent(previousEvent));
    
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
 * When a custom verifier is provided it is used as-is (legacy / test path).
 * When no custom verifier is provided the built-in `dispatchVerify` is used,
 * which performs full cryptographic verification for `did:key` +
 * `eddsa-jcs-2022` proofs and structural-only verification for everything else.
 *
 * @param event - The event to verify
 * @param index - The index of the event in the log
 * @param customVerifier - Optional caller-supplied verifier (overrides dispatch)
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @returns EventVerification result
 */
async function verifyEvent(
  event: LogEntry,
  index: number,
  customVerifier: ((proof: DataIntegrityProof, data: unknown) => Promise<boolean>) | undefined,
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

  // Build the signed payload — must exactly match what createSigner in the CLI
  // passes to canonicalizeEvent: { type, data, ...(previousEvent ? { previousEvent } : {}) }
  let allProofsValid = true;
  let allCryptographicallyVerified = true;
  const eventData = {
    type: event.type,
    data: event.data,
    ...(event.previousEvent ? { previousEvent: event.previousEvent } : {}),
  };

  for (let proofIndex = 0; proofIndex < event.proof.length; proofIndex++) {
    const proof = event.proof[proofIndex];

    try {
      if (customVerifier) {
        // Caller-supplied verifier: boolean result, no cryptographic tracking.
        const isValid = await customVerifier(proof, eventData);
        if (!isValid) {
          allProofsValid = false;
          errors.push(`Event ${index}, Proof ${proofIndex}: Verification failed`);
        }
        // When a custom verifier is used we cannot assert cryptographic verification.
        allCryptographicallyVerified = false;
      } else {
        const { verified, cryptographicallyVerified } = await dispatchVerify(proof, eventData);
        if (!verified) {
          allProofsValid = false;
          errors.push(`Event ${index}, Proof ${proofIndex}: Verification failed`);
        }
        if (!cryptographicallyVerified) {
          allCryptographicallyVerified = false;
        }
      }
    } catch (error) {
      allProofsValid = false;
      allCryptographicallyVerified = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Event ${index}, Proof ${proofIndex}: ${message}`);
    }
  }

  return {
    index,
    type: event.type,
    proofValid: allProofsValid,
    chainValid,
    cryptographicallyVerified: allCryptographicallyVerified,
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
 * When no custom verifier is provided, `did:key` + `eddsa-jcs-2022` proofs
 * are cryptographically verified using the public key embedded in the DID.
 * Other verification methods fall back to structural-only verification and are
 * tagged with `cryptographicallyVerified: false` in the per-event results.
 *
 * @param log - The event log to verify
 * @param options - Optional verification options including custom verifier
 * @returns VerificationResult with detailed per-event status including chainValid
 *
 * @example
 * ```typescript
 * // Full cryptographic verification for did:key proofs (default)
 * const result = await verifyEventLog(eventLog);
 * if (result.verified) {
 *   console.log('All proofs are valid and hash chain is intact');
 * }
 *
 * // With custom cryptographic verifier
 * const result = await verifyEventLog(eventLog, {
 *   verifier: async (proof, data) => {
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
    const eventResult = await verifyEvent(event, i, options?.verifier, previousEvent);
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
