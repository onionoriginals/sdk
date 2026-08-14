/**
 * The one root signer interface (plan 039). The smallest capability a custody
 * backend (Turnkey, KMS, HSM, MPC, passkey) can implement: sign opaque bytes.
 * The SDK owns canonicalization and hashing (see `signingInput`); the signer
 * owns the key and nothing else.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey } from './Multikey.js';
import { signerForKeyType } from './Signer.js';
import { signingInput } from './signingInput.js';
import { StructuredError } from '../utils/telemetry.js';
import type { KeyStore, ExternalSigner } from '../types/common.js';
import type { KeyPair } from '../types/bitcoin.js';
import type { DataIntegrityProof } from '../cel/types.js';
import type { CelSigner } from '../cel/layers/PeerCelManager.js';

export interface OriginalsSigner {
  /** Absolute verification method id, e.g. "did:key:z6Mk…#z6Mk…". */
  readonly verificationMethodId: string;
  /** Multikey-encoded public key — lets the SDK pick the suite and self-verify offline. */
  readonly publicKeyMultibase: string;
  /** Sign exactly these bytes. The SDK owns canonicalization; the signer owns the key. */
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * The canonical `did:key` verification method for a Multikey public key —
 * the identity CEL authorship uses regardless of the signer's ambient
 * `verificationMethodId` (CEL verification is offline did:key-only).
 */
export function canonicalDidKeyVm(publicKeyMultibase: string): string {
  return `did:key:${publicKeyMultibase}#${publicKeyMultibase}`;
}

/** Derive a Multikey public key from a `did:key` VM id; null for other methods. */
function publicKeyFromDidKeyVm(vmId: string): string | null {
  if (!vmId.startsWith('did:key:')) return null;
  const mk = vmId.slice('did:key:'.length).split('#')[0];
  return mk.startsWith('z') ? mk : null;
}

/**
 * Wraps a raw multibase key pair as an {@link OriginalsSigner} under its
 * canonical `did:key` identity. Supports every Multikey type; the signature
 * scheme is the one `signerForKeyType` pins to the key's multicodec header.
 */
export function signerFromKeyPair(keyPair: KeyPair): OriginalsSigner {
  const pub = multikey.decodePublicKey(keyPair.publicKey);
  const priv = multikey.decodePrivateKey(keyPair.privateKey);
  if (priv.type !== pub.type) {
    throw new StructuredError('INVALID_KEY_PAIR',
      `Key pair type mismatch: private key is ${priv.type}, public key is ${pub.type}.`);
  }
  // Ed25519 pairs are cheap to derive-check; a mismatched pair must fail here,
  // not as an unverifiable proof later.
  if (pub.type === 'Ed25519') {
    const derived = multikey.encodePublicKey(ed25519.getPublicKey(priv.key), 'Ed25519');
    if (derived !== keyPair.publicKey) {
      throw new StructuredError('INVALID_KEY_PAIR',
        'The supplied private key does not derive the supplied public key.');
    }
  }
  const signer = signerForKeyType(pub.type);
  return {
    verificationMethodId: canonicalDidKeyVm(keyPair.publicKey),
    publicKeyMultibase: keyPair.publicKey,
    async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await signer.sign(Buffer.from(bytes), keyPair.privateKey));
    },
  };
}

/**
 * Wraps a {@link KeyStore} entry as an {@link OriginalsSigner}. The private key
 * is looked up lazily on EVERY sign (matching `createKeyStoreCelSigner`):
 * rotation-fresh, and key absence fails at sign time, not construction time.
 *
 * The public key is taken from `publicKeyMultibase` when given, else derived
 * from a `did:key` VM id — for any other DID method it must be supplied.
 */
export function signerFromKeyStore(
  keyStore: KeyStore,
  verificationMethodId: string,
  opts?: { publicKeyMultibase?: string }
): OriginalsSigner {
  const pub = opts?.publicKeyMultibase ?? publicKeyFromDidKeyVm(verificationMethodId);
  if (!pub) {
    throw new StructuredError('SIGNER_PUBLIC_KEY_REQUIRED',
      `Cannot derive a public key from ${verificationMethodId}; pass opts.publicKeyMultibase.`);
  }
  const pubType = multikey.decodePublicKey(pub).type;
  return {
    verificationMethodId,
    publicKeyMultibase: pub,
    async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
      const priv = await keyStore.getPrivateKey(verificationMethodId);
      if (!priv) {
        throw new StructuredError('SIGNING_KEY_NOT_FOUND',
          `No private key in keyStore for ${verificationMethodId}`);
      }
      return new Uint8Array(await signerForKeyType(pubType).sign(Buffer.from(bytes), priv));
    },
  };
}

/**
 * Adapts a legacy {@link ExternalSigner} to {@link OriginalsSigner}. Requires
 * the byte-level `signBytes` capability — a document-level `sign()`-only signer
 * chooses its own canonicalization, which is exactly the layering mistake this
 * interface removes, so it throws loudly instead of adapting wrong.
 */
export function signerFromExternalSigner(
  s: ExternalSigner,
  opts?: { publicKeyMultibase?: string }
): OriginalsSigner {
  if (typeof s.signBytes !== 'function') {
    throw new StructuredError('EXTERNAL_SIGNER_SIGNBYTES_REQUIRED',
      'ExternalSigner must implement signBytes(data) to be adapted to OriginalsSigner; ' +
      'a document-level sign()-only signer canonicalizes for itself and cannot sign SDK-owned preimages.');
  }
  const vmId = s.getVerificationMethodId();
  const pub = opts?.publicKeyMultibase ?? publicKeyFromDidKeyVm(vmId);
  if (!pub) {
    throw new StructuredError('SIGNER_PUBLIC_KEY_REQUIRED',
      `Cannot derive a public key from ${vmId}; pass opts.publicKeyMultibase.`);
  }
  return {
    verificationMethodId: vmId,
    publicKeyMultibase: pub,
    async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
      const result = await s.signBytes!(bytes);
      const signature = result?.signature;
      if (!(signature instanceof Uint8Array)) {
        throw new StructuredError('EXTERNAL_SIGNER_INVALID_RESULT',
          `ExternalSigner.signBytes for ${vmId} must return { signature: Uint8Array }.`);
      }
      return signature;
    },
  };
}

/**
 * Legacy bridge: an {@link OriginalsSigner} as a CEL signer. Ed25519-only (CEL
 * is Ed25519 end-to-end — anything else throws). Proofs are stamped with the
 * canonical `did:key` VM derived from the signer's public key, NOT its ambient
 * `verificationMethodId`: CEL verification is offline did:key-only, and this is
 * what `celSignerFromKeyPair` has always done.
 */
export function toCelSigner(s: OriginalsSigner): CelSigner {
  const decoded = multikey.decodePublicKey(s.publicKeyMultibase);
  if (decoded.type !== 'Ed25519') {
    throw new StructuredError('CEL_ED25519_REQUIRED',
      `CEL events must be signed with Ed25519; got ${decoded.type}. Use a dedicated Ed25519 signer.`);
  }
  const verificationMethod = canonicalDidKeyVm(s.publicKeyMultibase);
  return async (data: unknown): Promise<DataIntegrityProof> => {
    const sig = await s.signBytes(
      signingInput.celEvent(data as { type: unknown; data?: unknown; previousEvent?: unknown })
    );
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(sig),
    };
  };
}

/**
 * Legacy bridge: an {@link OriginalsSigner} as a didwebvh-compatible
 * {@link ExternalSigner}. Correct by construction — its `sign()` is exactly
 * `signingInput.didWebvh` + `signBytes`, so it can never sign the wrong bytes.
 */
export function toExternalSigner(s: OriginalsSigner): ExternalSigner {
  return {
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
      const bytes = await signingInput.didWebvh(input.document, input.proof);
      return { proofValue: multikey.encodeMultibase(await s.signBytes(bytes)) };
    },
    async signBytes(data: Uint8Array) {
      return { signature: await s.signBytes(data) };
    },
    getVerificationMethodId(): string {
      return s.verificationMethodId;
    },
  };
}
