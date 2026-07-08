import type { Proof } from '../types/index.js';

/**
 * The only Data Integrity cryptosuite this SDK signs and verifies.
 * Multi-sig member proofs must declare it; anything else is either a legacy
 * proof from an older SDK release or an unsupported format.
 */
export const MULTISIG_CRYPTOSUITE = 'eddsa-rdfc-2022';

/**
 * Produce a caller-facing error message for a multi-sig member proof that
 * failed verification, distinguishing an UNSUPPORTED/legacy proof format from
 * a genuine bad signature (issue #306).
 *
 * A proof whose `cryptosuite` is missing or not {@link MULTISIG_CRYPTOSUITE}
 * (e.g. a legacy cryptosuite-less proof from a pre-Data-Integrity SDK release,
 * or a did:btco-inscribed provenance proof in an old format) can never verify
 * against the current path. Reporting the generic `Invalid signature from …`
 * for it is misleading — it suggests a tampered/forged signature rather than a
 * format that is simply no longer supported and must be re-signed.
 */
export function describeMultiSigProofFailure(proof: Proof, verificationMethod: string): string {
  const cryptosuite = (proof as { cryptosuite?: unknown }).cryptosuite;
  if (cryptosuite !== MULTISIG_CRYPTOSUITE) {
    const shown =
      cryptosuite === undefined
        ? 'undefined'
        : typeof cryptosuite === 'string'
          ? cryptosuite
          : JSON.stringify(cryptosuite);
    return (
      `Unsupported multi-sig proof format from ${verificationMethod}: ` +
      `cryptosuite ${shown} is not supported ` +
      `(only ${MULTISIG_CRYPTOSUITE}). Legacy-format proofs from older SDK releases must be re-signed — see issue #306.`
    );
  }
  return `Invalid signature from ${verificationMethod}`;
}
