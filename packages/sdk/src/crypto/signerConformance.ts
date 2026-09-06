/**
 * Published conformance harness for {@link OriginalsSigner} implementations
 * (plan 040). Any custody backend (Turnkey, KMS, HSM, MPC, passkey) can run
 * this against its signer before wiring it into the SDK; every check failure
 * throws a `SIGNER_NONCONFORMANT` StructuredError naming the exact violation.
 */

import { multikey, type MultikeyType } from '@originals/cel';
import { signerForKeyType } from './Signer.js';
import { StructuredError } from '@originals/cel';
import type { OriginalsSigner } from './OriginalsSigner.js';

// Ed25519/Bls signatures have fixed lengths; ECDSA compact signatures are 64.
const EXPECTED_SIG_LENGTHS: Record<string, number> = {
  Ed25519: 64,
  Secp256k1: 64,
  P256: 64,
  Bls12381G2: 48,
};

function fail(reason: string): never {
  throw new StructuredError('SIGNER_NONCONFORMANT', `Signer conformance failed: ${reason}`);
}

/**
 * Asserts that `signer` upholds the OriginalsSigner contract:
 *
 * 1. `verificationMethodId` is an ABSOLUTE VM id (`did:…#fragment`).
 * 2. `publicKeyMultibase` decodes as a Multikey public key.
 * 3. `signBytes` returns a `Uint8Array` of the expected length for the key type.
 * 4. The signature VERIFIES against `publicKeyMultibase` under the key type's
 *    signature scheme — the signer signs the bytes it was given, with the key
 *    it claims.
 * 5. Signatures are message-bound: a signature over one message must not
 *    verify another (catches fixed-output and input-ignoring signers).
 *
 * @throws StructuredError `SIGNER_NONCONFORMANT` naming the failed check.
 */
export async function assertSignerConformance(signer: OriginalsSigner): Promise<void> {
  // 1 — absolute VM id
  const vm = signer.verificationMethodId;
  if (typeof vm !== 'string' || !vm.startsWith('did:')) {
    fail(`verificationMethodId must be a DID URL string, got ${JSON.stringify(vm)}`);
  }
  const hashIdx = vm.indexOf('#');
  if (hashIdx <= 0 || hashIdx === vm.length - 1) {
    fail(`verificationMethodId must be absolute ("did:…#fragment"), got "${vm}"`);
  }

  // 2 — decodable public key
  let keyType: MultikeyType;
  try {
    keyType = multikey.decodePublicKey(signer.publicKeyMultibase).type;
  } catch (e) {
    fail(`publicKeyMultibase does not decode as a Multikey public key: ${(e as Error).message}`);
  }

  // 3 — signBytes shape
  const message1 = new TextEncoder().encode('originals-signer-conformance-probe-1');
  const message2 = new TextEncoder().encode('originals-signer-conformance-probe-2');
  let sig1: Uint8Array;
  try {
    sig1 = await signer.signBytes(message1);
  } catch (e) {
    fail(`signBytes threw: ${(e as Error).message}`);
  }
  if (!(sig1 instanceof Uint8Array)) {
    fail(`signBytes must return a Uint8Array, got ${typeof sig1}`);
  }
  const expectedLen = EXPECTED_SIG_LENGTHS[keyType];
  if (expectedLen !== undefined && sig1.length !== expectedLen) {
    fail(`signBytes returned ${sig1.length} bytes; ${keyType} signatures are ${expectedLen} bytes`);
  }

  // 4 — signature verifies against the claimed public key
  const verifier = signerForKeyType(keyType);
  if (!(await verifier.verify(message1, sig1, signer.publicKeyMultibase))) {
    fail(
      'the signature does not verify against publicKeyMultibase. The signer must sign EXACTLY ' +
      'the bytes it is given (no extra hashing or canonicalization) with the key it claims.'
    );
  }

  // 5 — message-bound signatures
  const sig2 = await signer.signBytes(message2);
  if (await verifier.verify(message1, sig2, signer.publicKeyMultibase)) {
    fail('a signature over one message verified a different message — the signer is ignoring its input');
  }
}
