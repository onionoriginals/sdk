import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import type { LocalVid } from '../message.js';
import { encodeX25519PublicMultikey, encodeX25519PrivateMultikey } from './multikey-x25519.js';
import { buildMultikeyDidDocument, resolveVidKeys, type VidKeys } from './resolve.js';

const ED25519_PUBLIC_PREFIX = new Uint8Array([0xed, 0x01]);

function ed25519PublicMultikey(publicKey: Uint8Array): string {
  const raw = new Uint8Array(ED25519_PUBLIC_PREFIX.length + publicKey.length);
  raw.set(ED25519_PUBLIC_PREFIX, 0);
  raw.set(publicKey, ED25519_PUBLIC_PREFIX.length);
  return `z${base58.encode(raw)}`;
}

export function createEphemeralTspIdentity(did: string, transport: string): LocalVid {
  const signingPrivateKey = ed25519.utils.randomSecretKey();
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const encryptionPrivateKey = x25519.utils.randomSecretKey();
  const encryptionPublicKey = x25519.getPublicKey(encryptionPrivateKey);
  return {
    id: did,
    transport,
    signingPrivateKey,
    signingPublicKey,
    encryptionPrivateKey,
    encryptionPublicKey,
  };
}

export function localVidToPublicKeys(vid: LocalVid): VidKeys {
  return {
    id: vid.id,
    transport: vid.transport ?? 'tsp://memory',
    signingPublicKey: vid.signingPublicKey,
    encryptionPublicKey: vid.encryptionPublicKey,
  };
}

export function didDocumentForLocalVid(vid: LocalVid): Record<string, unknown> {
  return buildMultikeyDidDocument(localVidToPublicKeys(vid));
}

export function localVidFromResolved(
  keys: VidKeys,
  signingPrivateKey: Uint8Array,
  encryptionPrivateKey: Uint8Array,
): LocalVid {
  return {
    id: keys.id,
    transport: keys.transport,
    signingPrivateKey,
    signingPublicKey: keys.signingPublicKey,
    encryptionPrivateKey,
    encryptionPublicKey: keys.encryptionPublicKey,
  };
}

/** Peer view: public keys only, resolved from a published DID document. */
export function peerVidFromDidDocument(doc: Record<string, unknown>): Omit<LocalVid, 'signingPrivateKey' | 'encryptionPrivateKey'> & {
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
} {
  const keys = resolveVidKeys(doc as never);
  return {
    id: keys.id,
    transport: keys.transport,
    signingPublicKey: keys.signingPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
  };
}

export function assertDidDocumentMultikeyOnly(doc: Record<string, unknown>): void {
  const text = JSON.stringify(doc);
  if (text.includes('JsonWebKey2020')) {
    throw new Error('Originals did documents must not contain JsonWebKey2020 verification methods');
  }
  const vms = (doc.verificationMethod ?? []) as Array<{ type?: string }>;
  for (const vm of vms) {
    if (vm.type !== 'Multikey') {
      throw new Error(`unsupported verification method type: ${vm.type}`);
    }
  }
}

export { ed25519PublicMultikey, encodeX25519PublicMultikey, encodeX25519PrivateMultikey };