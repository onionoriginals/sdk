import { multikey } from '@originals/sdk';

/**
 * Convert Privy's public key format to multibase Multikey format
 * @param publicKeyHex - The public key in hex format from Privy
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
  const publicKeyBytes = hexToBytes(cleanHex);
  
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
 * Extract public key from Privy wallet object
 * @param wallet - Privy wallet object
 * @returns Public key in hex format or null if not found
 */
export function extractPublicKeyFromWallet(wallet: any): string | null {
  // Privy wallet structure varies by chain type
  // Try common fields
  if (wallet.publicKey) {
    return wallet.publicKey;
  }
  if (wallet.public_key) {
    return wallet.public_key;
  }
  if (wallet.address) {
    // For some chains, the address itself contains or is derived from the public key
    // This is chain-specific, so we may need to handle differently
    return wallet.address;
  }
  return null;
}
