/**
 * Bridges the SDK's keyStore/KeyManager world (multibase Multikey strings)
 * to CelSigner (eddsa-jcs-2022 DataIntegrityProof over JCS bytes).
 * CEL verification is Ed25519-only end-to-end — non-Ed25519 keys throw.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey } from '../crypto/Multikey.js';
import { canonicalizeEvent } from './canonicalize.js';
import { StructuredError } from '../utils/telemetry.js';
import { multibase } from '../utils/encoding.js';
import type { KeyStore } from '../types/common.js';
import type { KeyPair } from '../types/bitcoin.js';
import type { DataIntegrityProof, EventLog } from './types.js';
import type { CelSigner } from './layers/PeerCelManager.js';

const SHA2_256_MULTIHASH_PREFIX = Uint8Array.from([0x12, 0x20]);

function assertEd25519(privateKeyMultibase: string): Uint8Array {
  const decoded = multikey.decodePrivateKey(privateKeyMultibase);
  if (decoded.type !== 'Ed25519') {
    throw new StructuredError('CEL_ED25519_REQUIRED',
      `CEL events must be signed with Ed25519; got ${decoded.type}. Generate a dedicated Ed25519 controller key.`);
  }
  return decoded.key;
}

async function buildProof(secret: Uint8Array, verificationMethod: string, data: unknown): Promise<DataIntegrityProof> {
  // @noble/curves' ed25519.sign is synchronous (unlike @noble/ed25519's signAsync).
  const sig = ed25519.sign(canonicalizeEvent(data), secret);
  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(sig)
  };
}

export function celSignerFromKeyPair(keyPair: KeyPair): {
  signer: CelSigner; controller: string; verificationMethod: string;
} {
  const secret = assertEd25519(keyPair.privateKey);
  const controller = `did:key:${keyPair.publicKey}`;
  const verificationMethod = `${controller}#${keyPair.publicKey}`;
  return { signer: (data) => buildProof(secret, verificationMethod, data), controller, verificationMethod };
}

/** Lazy per-sign lookup: rotation-fresh, and key absence fails at sign time. */
export function createKeyStoreCelSigner(keyStore: KeyStore, verificationMethodId: string): CelSigner {
  return async (data) => {
    const priv = await keyStore.getPrivateKey(verificationMethodId);
    if (!priv) {
      throw new StructuredError('CEL_SIGNING_KEY_NOT_FOUND',
        `No private key in keyStore for ${verificationMethodId}`);
    }
    return buildProof(assertEd25519(priv), verificationMethodId, data);
  };
}

/** The controller's canonical VM: `<did>#<key>` for did:key, else `<did>#key-0`. */
function canonicalControllerVm(controller: string): string {
  return controller.startsWith('did:key:')
    ? `${controller}#${controller.slice('did:key:'.length)}`
    : `${controller}#key-0`;
}

/**
 * Folds a CEL log to the CURRENT controller's verification method: the genesis
 * `controller`'s did:key VM, unless a later `rotateKey` supersedes it (the LAST
 * rotation's `newController` wins). Mirrors PeerCelManager.getCurrentState.
 *
 * NOTE: this fold does NOT verify proofs — it replays event state the same way
 * the manager does; the signature check happens at verify time. Callers that
 * need authority guarantees must verify the log separately.
 */
export function currentControllerVm(log: EventLog): string {
  const events = log?.events ?? [];
  const genesis = events[0]?.data as { controller?: unknown } | undefined;
  let controller = typeof genesis?.controller === 'string' ? genesis.controller : undefined;
  for (let i = 1; i < events.length; i++) {
    if (events[i].type === 'rotateKey') {
      const nc = (events[i].data as { newController?: unknown })?.newController;
      if (typeof nc === 'string') controller = nc;
    }
  }
  if (!controller) {
    throw new StructuredError('CEL_NO_CONTROLLER',
      'Cannot determine controller VM: genesis has no `controller` and no rotateKey supplied one.');
  }
  return canonicalControllerVm(controller);
}

/** AssetResource.hash (hex sha256) → CEL digestMultibase (multibase multihash). */
export function hexSha256ToDigestMultibase(hexHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hexHash)) {
    throw new StructuredError('INVALID_HASH', `Expected 64-char hex sha256, got ${hexHash.length} chars`);
  }
  const bytes = Uint8Array.from(hexHash.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const mh = new Uint8Array(2 + bytes.length);
  mh.set(SHA2_256_MULTIHASH_PREFIX, 0); mh.set(bytes, 2);
  return multibase.encode(mh, 'base64url');
}
