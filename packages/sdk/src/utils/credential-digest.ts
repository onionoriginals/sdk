import { canonicalizeDocument } from './serialization.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Canonical digest used by the legacy (non-DataIntegrity) credential signer and
 * verifier, and by MultiSigManager:
 *
 *   sha256(c14n(proof-without-proofValue)) || sha256(c14n(credential-without-proof))
 *
 * Byte-for-byte stable — changing this invalidates existing signatures. The
 * credential's `@context` is injected into the proof input when the proof lacks
 * one, and `publicKeyMultibase` (a post-signing key-discovery hint) is excluded
 * so signing and verification hash identical bytes.
 *
 * This is distinct from the Data Integrity (`eddsa-rdfc-2022`) digest in
 * `cryptosuites/eddsa.ts` — do not conflate the two.
 */
export async function computeCredentialDigest(
  credential: Record<string, unknown>,
  proofBase: Record<string, unknown>
): Promise<Uint8Array> {
  const proofInput: Record<string, unknown> = { ...proofBase };
  delete proofInput.proofValue;
  delete proofInput.publicKeyMultibase;

  const ctx = (credential as { '@context'?: unknown })['@context'];
  if (ctx && !proofInput['@context']) {
    proofInput['@context'] = ctx;
  }

  const unsigned: Record<string, unknown> = { ...credential };
  delete unsigned.proof;

  const c14nProof = await canonicalizeDocument(proofInput);
  const c14nCred = await canonicalizeDocument(unsigned);
  const hProof = sha256(Buffer.from(c14nProof, 'utf8'));
  const hCred = sha256(Buffer.from(c14nCred, 'utf8'));

  const out = new Uint8Array(hProof.length + hCred.length);
  out.set(hProof, 0);
  out.set(hCred, hProof.length);
  return out;
}
