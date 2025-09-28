import { base58btc } from 'multiformats/bases/base58';

// Multicodec headers (varints) for supported key types
export const MULTICODEC_ED25519_PUB_HEADER = new Uint8Array([0xed, 0x01]);
export const MULTICODEC_ED25519_PRIV_HEADER = new Uint8Array([0x80, 0x26]);
export const MULTICODEC_SECP256K1_PUB_HEADER = new Uint8Array([0xe7, 0x01]);
export const MULTICODEC_SECP256K1_PRIV_HEADER = new Uint8Array([0x13, 0x01]);
export const MULTICODEC_BLS12381_G2_PUB_HEADER = new Uint8Array([0xeb, 0x01]);
export const MULTICODEC_BLS12381_G2_PRIV_HEADER = new Uint8Array([0x82, 0x26]);
export const MULTICODEC_P256_PUB_HEADER = new Uint8Array([0x80, 0x24]);
export const MULTICODEC_P256_PRIV_HEADER = new Uint8Array([0x81, 0x26]);

export type MultikeyType = 'Ed25519' | 'Secp256k1' | 'Bls12381G2' | 'P256';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const multikey = {
  encodePublicKey: (publicKey: Uint8Array, type: MultikeyType): string => {
    const header =
      type === 'Ed25519'
        ? MULTICODEC_ED25519_PUB_HEADER
        : type === 'Secp256k1'
          ? MULTICODEC_SECP256K1_PUB_HEADER
          : type === 'Bls12381G2'
            ? MULTICODEC_BLS12381_G2_PUB_HEADER
            : MULTICODEC_P256_PUB_HEADER;
    const mcBytes = concatBytes(header, publicKey);
    return base58btc.encode(mcBytes);
  },

  encodePrivateKey: (privateKey: Uint8Array, type: MultikeyType): string => {
    const header =
      type === 'Ed25519'
        ? MULTICODEC_ED25519_PRIV_HEADER
        : type === 'Secp256k1'
          ? MULTICODEC_SECP256K1_PRIV_HEADER
          : type === 'Bls12381G2'
            ? MULTICODEC_BLS12381_G2_PRIV_HEADER
            : MULTICODEC_P256_PRIV_HEADER;
    const mcBytes = concatBytes(header, privateKey);
    return base58btc.encode(mcBytes);
  },

  decodePublicKey: (publicKeyMultibase: string): { key: Uint8Array; type: MultikeyType } => {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid Multibase encoding');
    }
    const mc = base58btc.decode(publicKeyMultibase);
    const header = mc.slice(0, 2);
    const key = mc.slice(2);
    if (header[0] === MULTICODEC_ED25519_PUB_HEADER[0] && header[1] === MULTICODEC_ED25519_PUB_HEADER[1]) {
      return { key, type: 'Ed25519' };
    }
    if (header[0] === MULTICODEC_SECP256K1_PUB_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PUB_HEADER[1]) {
      return { key, type: 'Secp256k1' };
    }
    if (header[0] === MULTICODEC_BLS12381_G2_PUB_HEADER[0] && header[1] === MULTICODEC_BLS12381_G2_PUB_HEADER[1]) {
      return { key, type: 'Bls12381G2' };
    }
    if (header[0] === MULTICODEC_P256_PUB_HEADER[0] && header[1] === MULTICODEC_P256_PUB_HEADER[1]) {
      return { key, type: 'P256' };
    }
    throw new Error('Unsupported key type');
  },

  decodePrivateKey: (privateKeyMultibase: string): { key: Uint8Array; type: MultikeyType } => {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid Multibase encoding');
    }
    const mc = base58btc.decode(privateKeyMultibase);
    const header = mc.slice(0, 2);
    const key = mc.slice(2);
    if (header[0] === MULTICODEC_ED25519_PRIV_HEADER[0] && header[1] === MULTICODEC_ED25519_PRIV_HEADER[1]) {
      return { key, type: 'Ed25519' };
    }
    if (header[0] === MULTICODEC_SECP256K1_PRIV_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PRIV_HEADER[1]) {
      return { key, type: 'Secp256k1' };
    }
    if (header[0] === MULTICODEC_BLS12381_G2_PRIV_HEADER[0] && header[1] === MULTICODEC_BLS12381_G2_PRIV_HEADER[1]) {
      return { key, type: 'Bls12381G2' };
    }
    if (header[0] === MULTICODEC_P256_PRIV_HEADER[0] && header[1] === MULTICODEC_P256_PRIV_HEADER[1]) {
      return { key, type: 'P256' };
    }
    throw new Error('Unsupported key type');
  }
};

