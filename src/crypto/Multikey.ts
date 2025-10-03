import { base58 } from '@scure/base';

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

/**
 * Validates that a key string uses proper multikey format.
 * @param key - The multibase-encoded key string to validate
 * @param expectedType - The expected key type (e.g., 'Ed25519', 'Secp256k1')
 * @param isPrivate - Whether this is a private key (true) or public key (false)
 * @throws Error with descriptive message if validation fails
 */
export function validateMultikeyFormat(
  key: string,
  expectedType: MultikeyType,
  isPrivate: boolean
): void {
  // Validate multibase prefix
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid multibase key format. Key must be a non-empty string.');
  }
  
  if (key[0] !== 'z') {
    throw new Error(
      'Invalid multibase key format. Keys must use z-base58btc encoding (prefix "z").'
    );
  }

  // Attempt to decode and validate multicodec header
  try {
    const mc = base58.decode(key.slice(1));
    
    if (mc.length < 2) {
      throw new Error(
        'Invalid multibase key format. Keys must use multicodec headers.'
      );
    }

    // Validate header matches expected type
    const header = mc.slice(0, 2);
    const expectedHeaders = isPrivate
      ? {
          Ed25519: MULTICODEC_ED25519_PRIV_HEADER,
          Secp256k1: MULTICODEC_SECP256K1_PRIV_HEADER,
          Bls12381G2: MULTICODEC_BLS12381_G2_PRIV_HEADER,
          P256: MULTICODEC_P256_PRIV_HEADER
        }
      : {
          Ed25519: MULTICODEC_ED25519_PUB_HEADER,
          Secp256k1: MULTICODEC_SECP256K1_PUB_HEADER,
          Bls12381G2: MULTICODEC_BLS12381_G2_PUB_HEADER,
          P256: MULTICODEC_P256_PUB_HEADER
        };

    const expectedHeader = expectedHeaders[expectedType];
    
    if (header[0] !== expectedHeader[0] || header[1] !== expectedHeader[1]) {
      throw new Error(
        `Invalid multibase key format. Expected ${expectedType} ${
          isPrivate ? 'private' : 'public'
        } key with multicodec header [0x${expectedHeader[0].toString(
          16
        )}, 0x${expectedHeader[1].toString(16)}], but found [0x${header[0].toString(
          16
        )}, 0x${header[1].toString(16)}].`
      );
    }

    // Validate key length (basic sanity check)
    const keyBytes = mc.slice(2);
    const expectedLengths: Record<MultikeyType, { private: number; public: number }> = {
      Ed25519: { private: 32, public: 32 },
      Secp256k1: { private: 32, public: 33 },
      P256: { private: 32, public: 33 },
      Bls12381G2: { private: 32, public: 96 }
    };

    const expectedLength = isPrivate
      ? expectedLengths[expectedType].private
      : expectedLengths[expectedType].public;

    if (keyBytes.length !== expectedLength) {
      throw new Error(
        `Invalid multibase key format. Expected ${expectedType} ${
          isPrivate ? 'private' : 'public'
        } key to be ${expectedLength} bytes, but found ${keyBytes.length} bytes.`
      );
    }
  } catch (error) {
    // Re-throw our own errors as-is
    if (error instanceof Error && error.message.startsWith('Invalid multibase key format')) {
      throw error;
    }
    // Base58 decode errors or other unexpected errors
    throw new Error(
      `Invalid multibase key format. Keys must use multicodec headers. Decode error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
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
    return 'z' + base58.encode(mcBytes);
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
    return 'z' + base58.encode(mcBytes);
  },

  encodeMultibase: (data: Uint8Array | Buffer): string => {
    return 'z' + base58.encode(data instanceof Buffer ? new Uint8Array(data) : data);
  },

  decodePublicKey: (publicKeyMultibase: string): { key: Uint8Array; type: MultikeyType } => {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid Multibase encoding');
    }
    const mc = base58.decode(publicKeyMultibase.slice(1));
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
    const mc = base58.decode(privateKeyMultibase.slice(1));
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

