/**
 * CEL proof primitives — the structural check, the `did:key` key extraction,
 * and the offline Ed25519 signature check.
 *
 * Extracted from `algorithms/verifyEventLog.ts` so the SEALING path
 * (`createEventLog` / `appendEvent`) can self-verify a freshly produced proof
 * without importing the full 1.8k-line verifier (and its Bitcoin/resource
 * dependencies) into the browser-safe `/cel` entry.
 */

import { verifyAsync } from '@noble/ed25519';
import { multikey } from './crypto/Multikey.js';
import { canonicalizeEvent, celProofSigningInput } from './canonicalize.js';
import type { DataIntegrityProof } from './types.js';

/**
 * The cryptosuite CEL proofs are WRITTEN with (plan 042).
 *
 * Bespoke on purpose. The previous label was `eddsa-jcs-2022`, but the
 * construction was not that suite: there was no hashing step and the proof
 * configuration was excluded from the signature, so a conforming Data
 * Integrity implementation could never interoperate in either direction while
 * the name promised it could. This name claims nothing it does not do.
 *
 * The construction is `sha256(JCS(proofConfig)) || sha256(JCS(event))`, signed
 * with Ed25519 — see `celProofSigningInput`.
 */
export const CEL_CRYPTOSUITE = 'originals-cel-ed25519-jcs-v1';

/**
 * The pre-042 label, accepted on READ and never written again.
 *
 * Its signature covers the event alone, so the proof configuration —
 * `created`, `verificationMethod`, `proofPurpose`, and the suite label itself —
 * is unattested and editable. Logs sealed before 042 cannot be re-signed, so
 * they keep verifying under their original rules; new logs get the stronger
 * ones. External artifacts (a competing anchoring's DID document, written by
 * another implementation) may also still carry this label.
 */
export const CEL_CRYPTOSUITE_LEGACY = 'eddsa-jcs-2022';

/** Suites a CEL proof may carry: one written, one read-only. */
export const CEL_CRYPTOSUITES = [CEL_CRYPTOSUITE, CEL_CRYPTOSUITE_LEGACY] as const;

/** Why a proof could not be verified. Surfaced in `VerificationResult.errors`. */
export type ProofFailureReason =
  | 'malformed proof'
  | `unsupported cryptosuite "${string}" (CEL requires ${string})`
  | `no resolver for ${string}`
  | `unresolvable key for ${string}`
  | 'non-Ed25519 did:key'
  | 'signature mismatch';

export interface ProofCheck {
  verified: boolean;
  cryptographicallyVerified: boolean;
  reason?: string;
}

/**
 * Validates the structural requirements of a DataIntegrityProof (field
 * presence, multibase prefix, supported cryptosuite). A precondition for the
 * cryptographic verifiers — never sufficient on its own.
 *
 * @returns `null` when structurally valid, else the reason it is not.
 */
export function structuralCheckReason(proof: DataIntegrityProof): string | null {
  if (!proof.type || proof.type !== 'DataIntegrityProof') return 'malformed proof';
  if (!proof.cryptosuite) return 'malformed proof';
  if (!proof.proofValue || typeof proof.proofValue !== 'string' || proof.proofValue.length === 0) {
    return 'malformed proof';
  }
  if (!proof.verificationMethod || typeof proof.verificationMethod !== 'string') return 'malformed proof';
  if (!proof.proofPurpose || typeof proof.proofPurpose !== 'string') return 'malformed proof';
  if (!(CEL_CRYPTOSUITES as readonly string[]).includes(proof.cryptosuite)) {
    return `unsupported cryptosuite "${proof.cryptosuite}" (CEL requires ${CEL_CRYPTOSUITE}` +
      `, or ${CEL_CRYPTOSUITE_LEGACY} for logs sealed before it)`;
  }
  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) return 'malformed proof';
  return null;
}

/** Boolean form of {@link structuralCheckReason}. */
export function structuralCheck(proof: DataIntegrityProof): boolean {
  return structuralCheckReason(proof) === null;
}

/**
 * Extracts the Ed25519 public key bytes embedded in a `did:key` verification
 * method URI (`did:key:<multikey>#<fragment>`). Returns `null` for non-Ed25519
 * keys or if decoding fails — callers must fail closed on `null`.
 */
export function extractEd25519FromDidKey(verificationMethod: string): Uint8Array | null {
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
 * Verifies a proof against a public key it already holds. Shared tail of every
 * verification path.
 */
export async function verifyProofWithKey(
  proof: DataIntegrityProof,
  data: unknown,
  publicKey: Uint8Array
): Promise<ProofCheck> {
  try {
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);
    const ok = await verifyAsync(signatureBytes, celPreimageFor(proof, data), publicKey);
    return ok
      ? { verified: true, cryptographicallyVerified: true }
      : { verified: false, cryptographicallyVerified: false, reason: 'signature mismatch' };
  } catch {
    return { verified: false, cryptographicallyVerified: false, reason: 'signature mismatch' };
  }
}

/**
 * Cryptographically verifies a `did:key` Ed25519 CEL proof. The public key is
 * extracted directly from the `verificationMethod` URI, so this works offline
 * with no DID resolver — which is what makes seal-time self-verification free.
 */
export async function verifyDidKeyProof(proof: DataIntegrityProof, data: unknown): Promise<ProofCheck> {
  const structural = structuralCheckReason(proof);
  if (structural) return { verified: false, cryptographicallyVerified: false, reason: structural };

  if (!proof.verificationMethod.startsWith('did:key:')) {
    return { verified: false, cryptographicallyVerified: false, reason: 'not a did:key verification method' };
  }

  const publicKeyBytes = extractEd25519FromDidKey(proof.verificationMethod);
  if (!publicKeyBytes) {
    return { verified: false, cryptographicallyVerified: false, reason: 'non-Ed25519 did:key' };
  }

  return verifyProofWithKey(proof, data, publicKeyBytes);
}

/**
 * The bytes a proof's signature must cover, chosen by its declared suite.
 *
 * Dispatching on the label is safe precisely because the new construction
 * binds the label: a legacy proof relabelled to the new suite fails (its
 * signature does not cover the config), and a new proof relabelled to the
 * legacy suite fails too (the legacy preimage is not what was signed).
 */
function celPreimageFor(proof: DataIntegrityProof, data: unknown): Uint8Array {
  if (proof.cryptosuite === CEL_CRYPTOSUITE_LEGACY) {
    // Pre-042: the event alone, unhashed, with the config unattested.
    return canonicalizeEvent(data);
  }
  return celProofSigningInput(data, proof as unknown as Record<string, unknown>);
}
