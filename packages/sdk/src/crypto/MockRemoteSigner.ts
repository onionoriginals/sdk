/**
 * In-repo model of a NON-EXPORTING custody backend (plan 040): implements ONLY
 * `signBytes`. No key export, no document-level `sign()` — if an SDK path needs
 * anything beyond sign-bytes, tests running under this signer fail, which is
 * the point. Every documented end-to-end flow has a test that runs under it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey } from '@originals/cel';
import { canonicalDidKeyVm, type OriginalsSigner } from './OriginalsSigner.js';

export class MockRemoteSigner implements OriginalsSigner {
  readonly verificationMethodId: string;
  readonly publicKeyMultibase: string;
  /** Number of signBytes calls served — lets tests assert the SDK actually signed remotely. */
  signBytesCalls = 0;
  // Held privately, like an HSM: nothing on this class can ever surface it.
  #secretKey: Uint8Array;

  constructor() {
    this.#secretKey = ed25519.utils.randomSecretKey();
    this.publicKeyMultibase = multikey.encodePublicKey(ed25519.getPublicKey(this.#secretKey), 'Ed25519');
    this.verificationMethodId = canonicalDidKeyVm(this.publicKeyMultibase);
  }

  async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('MockRemoteSigner.signBytes expects Uint8Array bytes');
    }
    this.signBytesCalls++;
    // Yield a microtask so callers cannot depend on synchronous completion.
    await Promise.resolve();
    return ed25519.sign(bytes, this.#secretKey);
  }
}
