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
} from '../types.js';
import { computeDigestMultibase } from '../hash.js';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../canonicalize.js';
import { multikey } from '../../crypto/Multikey.js';

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
 * Extracts the Ed25519 public key bytes embedded in a `did:key` verification
 * method URI (`did:key:<multikey>#<fragment>`).  Returns `null` for non-Ed25519
 * keys or if decoding fails — callers must fail closed on `null`.
 */
function extractEd25519FromDidKey(verificationMethod: string): Uint8Array | null {
  try {
    const withoutPrefix = verificationMethod.slice('did:key:'.length);
    const multikeyStr = withoutPrefix.split('#')[0];
    const decoded = multikey.decodePublicKey(multikeyStr);
    return decoded.type === 'Ed25519' ? decoded.key : null;
  } catch {
    return null;
  }
}

/**
 * Cryptographically verifies a `did:key` Ed25519 `eddsa-jcs-2022` proof.
 *
 * The public key is extracted directly from the `verificationMethod` URI
 * (`did:key:<multikey>#<fragment>`) so no DID resolver is required.
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

  // Only handle did:key verification methods.
  if (!proof.verificationMethod.startsWith('did:key:')) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Only handle eddsa-jcs-2022 cryptosuite.
  if (proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { verified: false, cryptographicallyVerified: false };
  }

  const publicKeyBytes = extractEd25519FromDidKey(proof.verificationMethod);
  if (!publicKeyBytes) {
    // Non-Ed25519 key or decoding failure — fail closed.
    return { verified: false, cryptographicallyVerified: false };
  }

  try {
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);
    const message = canonicalizeEvent(data);
    const ok = await verifyAsync(signatureBytes, message, publicKeyBytes);
    return { verified: ok, cryptographicallyVerified: ok };
  } catch {
    return { verified: false, cryptographicallyVerified: false };
  }
}

/**
 * Dispatching verifier used when no custom verifier is provided.
 *
 * Verifies ALL proof methods cryptographically or fails closed:
 * - `did:key` proofs: key is extracted locally (offline, no resolver).
 * - All other DID methods: key is fetched via `resolveKey`; if no resolver is
 *   provided the proof fails closed.
 *
 * Structural validity is only a precondition — it never alone yields
 * `verified: true`.
 *
 * Returns the full `{ verified, cryptographicallyVerified }` pair.
 */
async function dispatchVerify(
  proof: DataIntegrityProof,
  data: unknown,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<{ verified: boolean; cryptographicallyVerified: boolean }> {
  // Precondition: structural validity.
  if (!structuralCheck(proof)) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // CEL signatures are Ed25519-over-JCS; any other suite cannot be verified
  // here and must fail closed (incl. eddsa-rdfc-2022).
  if (proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Obtain the public key.
  let publicKey: Uint8Array | null = null;

  if (proof.verificationMethod.startsWith('did:key:')) {
    // Key is embedded in the identifier — works offline, no resolver needed.
    publicKey = extractEd25519FromDidKey(proof.verificationMethod);
  } else {
    // Key lives in a remote DID document — requires a resolver.
    if (!resolveKey) {
      return { verified: false, cryptographicallyVerified: false };
    }
    publicKey = await resolveKey(proof.verificationMethod);
  }

  if (!publicKey) {
    return { verified: false, cryptographicallyVerified: false };
  }

  try {
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);
    const message = canonicalizeEvent(data);
    const ok = await verifyAsync(signatureBytes, message, publicKey);
    return { verified: ok, cryptographicallyVerified: ok };
  } catch {
    return { verified: false, cryptographicallyVerified: false };
  }
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
    
    // Compute the expected hash of the previous event. The chain link covers
    // ONLY the committed fields ({type, data, previousEvent}) — the same
    // message the signer signed. The proof array (proofValue + unsigned
    // metadata like created/verificationMethod, plus any witness proofs added
    // later) is excluded, so the chain cannot depend on data no signature
    // commits to. See canonicalizeEntryForChain.
    const expectedHash = computeDigestMultibase(canonicalizeEntryForChain(previousEvent));
    
    if (event.previousEvent !== expectedHash) {
      errors.push(`Event ${index}: Hash chain broken - previousEvent does not match hash of prior event`);
      return { chainValid: false, errors };
    }
  }
  
  return { chainValid: true, errors: [] };
}

/**
 * Returns true when the proof is a third-party witness attestation.
 * Mirrors the discriminator in src/cel/serialization/cbor.ts.
 * Controller proofs never carry `witnessedAt` (confirmed: createSigner /
 * createEventLog do not set this field).
 */
function isWitnessProof(p: DataIntegrityProof): boolean {
  return 'witnessedAt' in p && typeof (p as { witnessedAt?: unknown }).witnessedAt === 'string';
}

/**
 * Resolves a proof's controller PUBLIC KEY, which is the correct unit of
 * authorization: two verification methods identify the same signer iff they
 * resolve to the same key material.
 *
 * Comparing raw verification-method URIs is wrong in both directions:
 * - too loose if the fragment is stripped (`#key-0` vs `#key-1` in one DID doc
 *   are DISTINCT keys), and
 * - too strict if compared verbatim (the same key spelled with a different but
 *   equivalent VM id — which the key resolver already treats as equal — would
 *   be rejected).
 *
 * did:key proofs carry the key in the identifier (resolved offline); other
 * methods use the same `resolveKey` resolver as `dispatchVerify`. Returns a hex
 * string so keys can be compared/stored in a Set, or null if unresolvable.
 */
async function resolveControllerKeyHex(
  verificationMethod: string,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<string | null> {
  let key: Uint8Array | null = null;
  if (verificationMethod.startsWith('did:key:')) {
    key = extractEd25519FromDidKey(verificationMethod);
  } else if (resolveKey) {
    try {
      key = await resolveKey(verificationMethod);
    } catch {
      key = null;
    }
  }
  return key ? Buffer.from(key).toString('hex') : null;
}

/**
 * Verifies a single event's proofs.
 *
 * Controller proofs (those without `witnessedAt`) gate the overall
 * `proofValid`/`cryptographicallyVerified` result.  Witness proofs (those with
 * `witnessedAt`) are verified with the same mechanism and reported in
 * `witnessProofs`, but a failed or unresolvable witness does NOT affect the
 * overall result — witnesses add trust, they do not let a third party's
 * availability invalidate the controller's signature.
 *
 * When a custom verifier is provided it is used for every proof (controller +
 * witness) on the legacy / test path.
 *
 * @param event - The event to verify
 * @param index - The index of the event in the log
 * @param customVerifier - Optional caller-supplied verifier (overrides dispatch)
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @param resolveKey - Optional key resolver for non-did:key proofs
 * @returns EventVerification result
 */
async function verifyEvent(
  event: LogEntry,
  index: number,
  customVerifier: ((proof: DataIntegrityProof, data: unknown) => Promise<boolean>) | undefined,
  previousEvent: LogEntry | undefined,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>,
  authorizedKeyIds?: Set<string>
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
  const eventData = {
    type: event.type,
    data: event.data,
    ...(event.previousEvent ? { previousEvent: event.previousEvent } : {}),
  };

  // Separate controller proofs from witness proofs.
  const controllerProofs: { proof: DataIntegrityProof; originalIndex: number }[] = [];
  const witnessProofEntries: { proof: DataIntegrityProof; originalIndex: number }[] = [];

  for (let i = 0; i < event.proof.length; i++) {
    if (isWitnessProof(event.proof[i])) {
      witnessProofEntries.push({ proof: event.proof[i], originalIndex: i });
    } else {
      controllerProofs.push({ proof: event.proof[i], originalIndex: i });
    }
  }

  // Require at least one controller proof.
  if (controllerProofs.length === 0) {
    errors.push(`Event ${index}: no controller proof`);
    return {
      index,
      type: event.type,
      proofValid: false,
      chainValid,
      errors,
    };
  }

  // Controller binding: on the default (dispatch) path, every controller proof
  // must be signed by a key authorized by the log's create event. Without this,
  // any key can append/rename/migrate/deactivate someone else's log and it
  // verifies (confirmed forgeable). Authorization compares the resolved PUBLIC
  // KEY (not the VM URI string), so it is neither fooled by two distinct keys
  // in one DID document nor tripped up by the same key under an equivalent VM
  // id. A custom verifier takes full responsibility for authorization, so this
  // check is skipped there.
  if (!customVerifier && authorizedKeyIds && index > 0) {
    for (const { proof, originalIndex } of controllerProofs) {
      const keyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
      if (keyHex === null || !authorizedKeyIds.has(keyHex)) {
        errors.push(
          `Event ${index}, Proof ${originalIndex}: signer ${proof.verificationMethod} is not authorized by the log's create event`
        );
        return {
          index,
          type: event.type,
          proofValid: false,
          chainValid,
          cryptographicallyVerified: false,
          errors,
        };
      }
    }
  }

  // Verify controller proofs — these gate `proofValid` and `cryptographicallyVerified`.
  let allControllerProofsValid = true;
  let allCryptographicallyVerified = true;

  for (const { proof, originalIndex } of controllerProofs) {
    try {
      if (customVerifier) {
        const isValid = await customVerifier(proof, eventData);
        if (!isValid) {
          allControllerProofsValid = false;
          errors.push(`Event ${index}, Proof ${originalIndex}: Verification failed`);
        }
        // When a custom verifier is used we cannot assert cryptographic verification.
        allCryptographicallyVerified = false;
      } else {
        const { verified, cryptographicallyVerified } = await dispatchVerify(proof, eventData, resolveKey);
        if (!verified) {
          allControllerProofsValid = false;
          errors.push(`Event ${index}, Proof ${originalIndex}: Verification failed`);
        }
        if (!cryptographicallyVerified) {
          allCryptographicallyVerified = false;
        }
      }
    } catch (error) {
      allControllerProofsValid = false;
      allCryptographicallyVerified = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Event ${index}, Proof ${originalIndex}: ${message}`);
    }
  }

  // Verify witness proofs — NON-GATING: results go into `witnessProofs` only.
  const witnessResults: { verificationMethod: string; verified: boolean }[] = [];

  for (const { proof } of witnessProofEntries) {
    let witnessVerified = false;
    try {
      if (customVerifier) {
        witnessVerified = await customVerifier(proof, eventData);
      } else {
        const { verified } = await dispatchVerify(proof, eventData, resolveKey);
        witnessVerified = verified;
      }
    } catch {
      witnessVerified = false;
    }
    witnessResults.push({ verificationMethod: proof.verificationMethod, verified: witnessVerified });
  }

  const result: EventVerification = {
    index,
    type: event.type,
    proofValid: allControllerProofsValid,
    chainValid,
    ...(customVerifier ? {} : { cryptographicallyVerified: allCryptographicallyVerified }),
    errors,
  };

  if (witnessResults.length > 0) {
    result.witnessProofs = witnessResults;
  }

  return result;
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

  // Establish the authorized controller key from the create event (event 0):
  // the trust-on-first-use root of authority. The current CEL data model has
  // no in-log key-rotation mechanism, so this key is fixed by the create event.
  //
  // SECURITY: the hash chain and the controller signature cover only
  // { type, data, previousEvent } — NOT the proof array. So an attacker can
  // append their own valid controller proof to the create event without
  // breaking the chain or the owner's signature. If we seeded the authorized
  // set from ALL of the create event's controller proofs, that injected key
  // would become authorized and could sign forged later events. To close this,
  // the create event must carry EXACTLY ONE controller proof; more than one is
  // treated as tampering (its unsigned proof array cannot disambiguate the
  // real root from an injected co-signer) and fails the whole log.
  //
  // When a custom verifier is supplied, the caller owns proof semantics and
  // authorization (verifyEvent skips the controller-key binding on that path),
  // so this default authority check is skipped too — consistently.
  const createEvent = log.events[0];
  const authorizedKeyIds = new Set<string>();
  let authorityError: string | undefined;
  if (!options?.verifier) {
    // A non-array proof (missing, object, string, …) yields zero controller
    // proofs → authorityError below, rather than throwing on .filter.
    const createControllerProofs = Array.isArray(createEvent.proof)
      ? createEvent.proof.filter(p => !isWitnessProof(p))
      : [];
    if (createControllerProofs.length !== 1) {
      authorityError =
        `Create event must have exactly one controller proof to establish authority (found ` +
        `${createControllerProofs.length}); the create event's proof array is not signed, so ` +
        `additional controller proofs cannot be trusted.`;
    } else {
      const rootKeyHex = await resolveControllerKeyHex(createControllerProofs[0].verificationMethod, options?.resolveKey);
      if (rootKeyHex) authorizedKeyIds.add(rootKeyHex);
    }
  }

  // Verify each event's proofs and hash chain
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const previousEvent = i > 0 ? log.events[i - 1] : undefined;
    const eventResult = await verifyEvent(event, i, options?.verifier, previousEvent, options?.resolveKey, authorizedKeyIds);
    eventVerifications.push(eventResult);

    if (!eventResult.proofValid || !eventResult.chainValid) {
      errors.push(...eventResult.errors);
    }
  }

  // Determine overall verification status (both proofs AND chain must be valid,
  // and the create event must establish a single unambiguous authority key).
  const allProofsValid = eventVerifications.every(ev => ev.proofValid);
  const allChainsValid = eventVerifications.every(ev => ev.chainValid);

  if (authorityError) {
    errors.unshift(authorityError);
  }

  return {
    verified: allProofsValid && allChainsValid && !authorityError,
    errors,
    events: eventVerifications,
  };
}
