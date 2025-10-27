import { multikey } from '@originals/sdk';

/**
 * Convert Turnkey's public key format to multibase Multikey format
 * @param publicKeyHex - The public key in hex format from Turnkey
 * @param keyType - The type of key ('Secp256k1' for Bitcoin, 'Ed25519' for Stellar)
 * @returns The public key encoded in multibase format (z-base58btc with multicodec header)
 */
export function convertToMultibase(
  publicKeyHex: string,
  keyType: 'Secp256k1' | 'Ed25519'
): string {
  // Remove '0x' prefix if present
  const cleanHex = publicKeyHex.startsWith('0x') 
    ? publicKeyHex.slice(2) 
    : publicKeyHex;
  
  // Convert hex string to Uint8Array
  let publicKeyBytes = hexToBytes(cleanHex);
  
  // Some Ed25519 public keys include a version byte prefix
  // Ed25519 keys must be exactly 32 bytes, so remove the prefix if present
  if (keyType === 'Ed25519' && publicKeyBytes.length === 33) {
    publicKeyBytes = publicKeyBytes.slice(1);
  }
  
  // Use SDK's multikey.encodePublicKey() function
  return multikey.encodePublicKey(publicKeyBytes, keyType);
}

/**
 * Convert hex string to Uint8Array
 * @param hex - Hex string (without 0x prefix)
 * @returns Uint8Array representation of the hex string
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 * @param bytes - Uint8Array to convert
 * @returns Hex string representation (without 0x prefix)
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Extract public key from key object
 * @param key - Key object with publicKey field
 * @returns Public key in hex format
 * @throws Error if no public key is available
 */
export function extractPublicKeyFromWallet(key: any): string {
  // Try common fields for public key
  if (key.publicKey) {
    return key.publicKey;
  }
  if (key.public_key) {
    return key.public_key;
  }

  // If no public key is available, throw an error
  // DO NOT fall back to address fields as they're not in hex format
  // (Bitcoin addresses are bech32/base58, Stellar addresses are base32)
  throw new Error(
    `No public key available in key object. ` +
    `Key ID: ${key.id || 'unknown'}. ` +
    `The key object must contain a 'publicKey' or 'public_key' field.`
  );
}
