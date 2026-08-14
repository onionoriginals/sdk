/**
 * Seal-time proof production: call the signer, then PROVE the proof it returned
 * actually verifies before sealing it into the log.
 *
 * Why this exists: `createEventLog`/`appendEvent` previously checked only that
 * `type`/`cryptosuite`/`proofValue` were present. A signer using the wrong
 * preimage — the single most common remote-custody mistake, since the signer
 * used to choose its own canonicalization — sealed a genesis whose did:cel
 * derives fine, whose log looks well-formed, and which can never verify. The
 * failure surfaced arbitrarily far from its cause, often after the asset was
 * already inscribed.
 *
 * For `did:key` the public key is in the verification method, so the check is
 * offline and costs one Ed25519 verify per append.
 */

import { StructuredError } from '../../utils/telemetry.js';
import { verifyDidKeyProof } from '../proofVerification.js';
import type { DataIntegrityProof } from '../types.js';

export interface SealOptions {
  /**
   * Verify the produced proof before sealing it (default `true`).
   *
   * Only set this to `false` when deliberately constructing an invalid log —
   * e.g. a tamper-detection fixture. It cannot make an unverifiable proof
   * verifiable; it only defers the failure to read time.
   */
  verifyOnSign?: boolean;
}

/**
 * Produces the proof for `eventBase` and validates it.
 *
 * @throws StructuredError `CEL_PROOF_INVALID` when the signer returned a
 *   structurally incomplete proof.
 * @throws StructuredError `CEL_PROOF_SELF_VERIFY_FAILED` when the proof is
 *   well-formed but does not verify against its own verification method.
 */
export async function sealProof(
  signer: (data: unknown) => Promise<DataIntegrityProof>,
  eventBase: { type: string; data: unknown; previousEvent?: string },
  options?: SealOptions
): Promise<DataIntegrityProof> {
  const proof = await signer(eventBase);

  if (!proof || !proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new StructuredError(
      'CEL_PROOF_INVALID',
      'Invalid proof: missing required fields (type, cryptosuite, proofValue)'
    );
  }

  if (options?.verifyOnSign === false) return proof;

  // Only `did:key` can be checked offline. Other DID methods need a resolver
  // the signing path does not have, so they are sealed unchecked — the log is
  // still gated at read time by `verifyEventLog`.
  if (!proof.verificationMethod?.startsWith('did:key:')) return proof;

  const { verified, reason } = await verifyDidKeyProof(proof, eventBase);
  if (!verified) {
    throw new StructuredError(
      'CEL_PROOF_SELF_VERIFY_FAILED',
      `Signer produced a proof that does not verify against its own verification method ` +
        `(${proof.verificationMethod}): ${reason}. The event was NOT appended. ` +
        `The usual cause is signing the wrong bytes: a CEL proof signs ` +
        `canonicalizeEvent({ type, data, previousEvent? }) — import canonicalizeEvent from ` +
        `'@originals/sdk/cel/canonicalize' to produce exactly those bytes.`
    );
  }
  return proof;
}
