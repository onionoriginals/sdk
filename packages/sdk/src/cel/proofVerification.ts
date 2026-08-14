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
import { multikey } from '../crypto/Multikey.js';
import { canonicalizeEvent } from './canonicalize.js';
import type { DataIntegrityProof } from './types.js';

/**
 * The ONLY cryptosuite a CEL controller proof may use. CEL signs Ed25519 over
 * JCS bytes; `eddsa-rdfc-2022` was previously admitted by the structural check
 * while the dispatcher failed it closed — a suite the validator accepted but
 * that could never verify. The two are now the same list by construction.
 *
 * NOTE: despite the label, this is NOT the W3C `eddsa-jcs-2022` construction —
 * there is no hashing step and the proof configuration is excluded from the
 * signature (see `canonicalize.ts`). Plan 042 renames it.
 */
export const CEL_CRYPTOSUITE = 'eddsa-jcs-2022';

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
  if (proof.cryptosuite !== CEL_CRYPTOSUITE) {
    return `unsupported cryptosuite "${proof.cryptosuite}" (CEL requires ${CEL_CRYPTOSUITE})`;
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
    const ok = await verifyAsync(signatureBytes, canonicalizeEvent(data), publicKey);
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
