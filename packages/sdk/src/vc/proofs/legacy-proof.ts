/**
 * Shared verification for LEGACY (cryptosuite-less) credential proofs:
 * a signature over the legacy credential digest (see utils/credential-digest),
 * with the signing key resolved from the proof's verificationMethod and the
 * signature algorithm chosen from the key's multicodec type.
 *
 * This is the single implementation used by both MultiSigManager and
 * Verifier — the fail-closed rules here (no lone-key fallback, key-type
 * dispatch, fail closed on unresolvable keys) are security-sensitive and must
 * not fork between call sites.
 */

import type { VerifiableCredential } from '../../types/index.js';
import type { DIDManager } from '../../did/DIDManager.js';
import { computeCredentialDigest } from '../../utils/credential-digest.js';
import { decodeBase64UrlMultibase } from '../../utils/encoding.js';
import { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from '../../crypto/Signer.js';
import { multikey } from '../../crypto/Multikey.js';

/**
 * Pick the Signer implementation matching a public multikey's codec type.
 * Returns null for unsupported key types (caller fails closed).
 */
export function signerForMultikey(publicKeyMultibase: string): Signer | null {
  try {
    const { type } = multikey.decodePublicKey(publicKeyMultibase);
    switch (type) {
      case 'Ed25519': return new Ed25519Signer();
      case 'Secp256k1': return new ES256KSigner();
      case 'P256': return new ES256Signer();
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * Resolve a proof's verificationMethod to its public multikey.
 * - did:key is self-certifying: the key IS the identifier.
 * - Other DID methods resolve through the DIDManager, and the verification
 *   method must match a published method's id (exactly, or by fragment).
 *   There is deliberately NO lone-key fallback: a proof whose
 *   verificationMethod does not match any published method must fail closed,
 *   not be checked against whichever single key the document happens to
 *   publish.
 */
export async function resolveSignerKey(
  verificationMethod: string,
  didManager?: DIDManager
): Promise<string | null> {
  if (verificationMethod.startsWith('did:key:')) {
    const keyPart = verificationMethod.split('#')[0];
    return keyPart.replace('did:key:', '');
  }
  if (!didManager || !verificationMethod.startsWith('did:')) {
    return null;
  }
  try {
    const did = verificationMethod.split('#')[0];
    const didDoc = await didManager.resolveDID(did);
    const vms = (didDoc as { verificationMethod?: Array<{ id?: string; publicKeyMultibase?: unknown }> } | null)
      ?.verificationMethod;
    if (!Array.isArray(vms)) return null;
    const fragment = verificationMethod.includes('#') ? verificationMethod.split('#')[1] : undefined;
    const match = vms.find(vm =>
      vm.id === verificationMethod ||
      (fragment !== undefined && typeof vm.id === 'string' && vm.id.split('#')[1] === fragment)
    );
    return match && typeof match.publicKeyMultibase === 'string' ? match.publicKeyMultibase : null;
  } catch {
    return null;
  }
}

/**
 * Verify one legacy (cryptosuite-less) proof against the credential.
 * Fails closed (returns false) on any missing field, unresolvable key,
 * unsupported key type, malformed proofValue, or signature mismatch.
 */
export async function verifyLegacyProof(
  credential: VerifiableCredential,
  proof: Record<string, unknown>,
  didManager?: DIDManager
): Promise<boolean> {
  try {
    const proofValue = proof.proofValue;
    const verificationMethod = proof.verificationMethod;
    if (typeof proofValue !== 'string' || typeof verificationMethod !== 'string') return false;

    const signature = decodeBase64UrlMultibase(proofValue);
    const digest = await computeCredentialDigest(
      credential as unknown as Record<string, unknown>,
      { ...proof, proofValue: '' }
    );

    const publicKeyMultibase = await resolveSignerKey(verificationMethod, didManager);
    if (!publicKeyMultibase) return false;

    const signer = signerForMultikey(publicKeyMultibase);
    if (!signer) return false;

    return await signer.verify(Buffer.from(digest), Buffer.from(signature), publicKeyMultibase);
  } catch {
    return false;
  }
}
