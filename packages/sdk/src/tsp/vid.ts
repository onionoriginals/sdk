import { decodeX25519PrivateMultikey, type LocalVid } from '@originals/tsp';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { multikey } from '../crypto/Multikey.js';

export function localVidFromWebVhKeys(
  did: string,
  transport: string,
  signingPrivateMultibase: string,
  encryptionPrivateMultibase: string,
): LocalVid {
  const { key: signingPrivateKey } = multikey.decodePrivateKey(signingPrivateMultibase);
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const encryptionPrivateKey = decodeX25519PrivateMultikey(encryptionPrivateMultibase);
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