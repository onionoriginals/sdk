/**
 * Real Ed25519 `did:key` CEL signers for tests.
 *
 * Test signers used to return a structurally-valid proof with a garbage
 * `proofValue`. That modelled the exact bug plan 034 fixes — the SDK sealed
 * proofs it had never verified — so no test could catch it. Seal-time
 * self-verification (`algorithms/sealProof.ts`) now rejects such proofs, and
 * tests sign for real instead.
 *
 * The key is embedded in the DID, so `verifyEventLog` verifies these offline
 * with no resolver.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey } from '../../src/crypto/Multikey';
import { signingInput } from '../../src/crypto/signingInput';
import { CEL_CRYPTOSUITE } from '../../src/cel/proofVerification';
import type { DataIntegrityProof } from '../../src/cel/types';

export interface RealCelSigner {
  /** Signs `{ type, data, previousEvent? }` exactly as the CEL verifier expects. */
  signer: (data: unknown) => Promise<DataIntegrityProof>;
  /** `did:key:<multikey>#<multikey>` — the VM recorded in the proof. */
  verificationMethod: string;
  /** `did:key:<multikey>` — the VM without its fragment. */
  controller: string;
  publicKeyMultibase: string;
  privateKeyBytes: Uint8Array;
}

/**
 * Generates a fresh Ed25519 keypair and returns a signer bound to it.
 *
 * @param proofPurpose - proof purpose to stamp (default `assertionMethod`)
 */
export function createRealCelSigner(proofPurpose = 'assertionMethod'): RealCelSigner {
  const privateKeyBytes = ed25519.utils.randomSecretKey();
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  const publicKeyMultibase = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  const controller = `did:key:${publicKeyMultibase}`;
  const verificationMethod = `${controller}#${publicKeyMultibase}`;

  const signer = async (data: unknown): Promise<DataIntegrityProof> => {
    // Mirrors what the SDK emits since plan 042: the proof configuration is
    // built first and signed along with the event.
    const config = {
      type: 'DataIntegrityProof' as const,
      cryptosuite: CEL_CRYPTOSUITE,
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose,
    };
    const bytes = signingInput.celEvent(
      data as { type: unknown; data?: unknown; previousEvent?: unknown },
      config
    );
    return { ...config, proofValue: multikey.encodeMultibase(ed25519.sign(bytes, privateKeyBytes)) };
  };

  return { signer, verificationMethod, controller, publicKeyMultibase, privateKeyBytes };
}

/**
 * A signer that returns a well-formed proof whose signature is deliberately
 * wrong — for asserting that a path REJECTS unverifiable proofs. Pair with
 * `verifyOnSign: false` when a test needs to build an invalid log on purpose.
 */
export function createBrokenCelSigner(verificationMethod: string) {
  return async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: 'z' + Buffer.from('not-a-signature-' + JSON.stringify(data)).toString('base64'),
  });
}
