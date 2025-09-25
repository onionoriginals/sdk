// Minimal base58btc encode/decode to avoid runtime ESM subpath issues in tests
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert base256 to base58
  const input = bytes.slice();
  const encoded: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let carry = 0;
    for (let i = start; i < input.length; i++) {
      const value = (input[i] & 0xff) + carry * 256;
      input[i] = value / 58 | 0;
      carry = value % 58;
    }
    encoded.push(carry);
    while (start < input.length && input[start] === 0) start++;
  }
  let result = 'z' + '1'.repeat(zeros);
  for (let i = encoded.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[encoded[i]];
  }
  return result;
}

function base58btcDecode(str: string): Uint8Array {
  if (!str || str[0] !== 'z') throw new Error('Invalid Multibase encoding');
  const s = str.slice(1);
  if (s.length === 0) return new Uint8Array(0);
  // Count leading '1's
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const base58: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const charIndex = BASE58_ALPHABET.indexOf(s[i]);
    if (charIndex === -1) throw new Error('Invalid base58 character');
    base58.push(charIndex);
  }
  // Convert base58 to base256
  const decoded: number[] = [];
  for (const digit of base58) {
    let carry = digit;
    for (let j = 0; j < decoded.length; j++) {
      const value = decoded[j] * 58 + carry;
      decoded[j] = value & 0xff;
      carry = value >> 8;
    }
    while (carry > 0) {
      decoded.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Add leading zeros
  for (let i = 0; i < zeros; i++) decoded.push(0);
  // Reverse to big-endian
  decoded.reverse();
  return new Uint8Array(decoded);
}

// Multicodec headers (varints) for supported key types
export const MULTICODEC_ED25519_PUB_HEADER = new Uint8Array([0xed, 0x01]);
export const MULTICODEC_ED25519_PRIV_HEADER = new Uint8Array([0x80, 0x26]);
export const MULTICODEC_SECP256K1_PUB_HEADER = new Uint8Array([0xe7, 0x01]);
export const MULTICODEC_SECP256K1_PRIV_HEADER = new Uint8Array([0x13, 0x01]);

export type MultikeyType = 'Ed25519' | 'Secp256k1';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const multikey = {
  encodePublicKey: (publicKey: Uint8Array, type: MultikeyType): string => {
    const header = type === 'Ed25519' ? MULTICODEC_ED25519_PUB_HEADER : MULTICODEC_SECP256K1_PUB_HEADER;
    const mcBytes = concatBytes(header, publicKey);
    return base58btcEncode(mcBytes);
  },

  encodePrivateKey: (privateKey: Uint8Array, type: MultikeyType): string => {
    const header = type === 'Ed25519' ? MULTICODEC_ED25519_PRIV_HEADER : MULTICODEC_SECP256K1_PRIV_HEADER;
    const mcBytes = concatBytes(header, privateKey);
    return base58btcEncode(mcBytes);
  },

  decodePublicKey: (publicKeyMultibase: string): { key: Uint8Array; type: MultikeyType } => {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid Multibase encoding');
    }
    const mc = base58btcDecode(publicKeyMultibase);
    const header = mc.slice(0, 2);
    const key = mc.slice(2);
    if (header[0] === MULTICODEC_ED25519_PUB_HEADER[0] && header[1] === MULTICODEC_ED25519_PUB_HEADER[1]) {
      return { key, type: 'Ed25519' };
    }
    if (header[0] === MULTICODEC_SECP256K1_PUB_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PUB_HEADER[1]) {
      return { key, type: 'Secp256k1' };
    }
    throw new Error('Unsupported key type');
  },

  decodePrivateKey: (privateKeyMultibase: string): { key: Uint8Array; type: MultikeyType } => {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid Multibase encoding');
    }
    const mc = base58btcDecode(privateKeyMultibase);
    const header = mc.slice(0, 2);
    const key = mc.slice(2);
    if (header[0] === MULTICODEC_ED25519_PRIV_HEADER[0] && header[1] === MULTICODEC_ED25519_PRIV_HEADER[1]) {
      return { key, type: 'Ed25519' };
    }
    if (header[0] === MULTICODEC_SECP256K1_PRIV_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PRIV_HEADER[1]) {
      return { key, type: 'Secp256k1' };
    }
    throw new Error('Unsupported key type');
  }
};

