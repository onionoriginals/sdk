/**
 * Signature Verification Utilities
 * Verifies signatures from frontend Turnkey signing
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * Verify a DID document signature
 * @param didDocument - The DID document that was signed
 * @param signature - The signature (hex string)
 * @param publicKey - The public key (multibase encoded)
 * @returns True if signature is valid
 */
export function verifyDIDSignature(
  didDocument: any,
  signature: string,
  publicKey: string
): boolean {
  try {
    // Create canonical form of DID document
    const canonicalDoc = JSON.stringify(didDocument, Object.keys(didDocument).sort());

    // Hash the document
    const messageHash = sha256(new TextEncoder().encode(canonicalDoc));

    // Decode the public key from multibase
    const publicKeyBytes = decodeMultibaseKey(publicKey);

    // Determine the key type based on the multibase prefix
    const keyType = getKeyType(publicKey);

    // Verify based on key type
    if (keyType === 'secp256k1') {
      return verifySecp256k1Signature(messageHash, signature, publicKeyBytes);
    } else if (keyType === 'ed25519') {
      return verifyEd25519Signature(messageHash, signature, publicKeyBytes);
    } else {
      throw new Error(`Unsupported key type: ${keyType}`);
    }
  } catch (error) {
    console.error('Error verifying DID signature:', error);
    return false;
  }
}

/**
 * Verify a credential signature
 * @param credential - The credential that was signed
 * @param proof - The proof object (without proofValue)
 * @param signature - The signature (hex string)
 * @param publicKey - The public key (multibase encoded)
 * @returns True if signature is valid
 */
export function verifyCredentialSignature(
  credential: any,
  proof: any,
  signature: string,
  publicKey: string
): boolean {
  try {
    // Create the data that was signed
    const dataToSign = JSON.stringify({
      credential,
      proof: {
        ...proof,
        proofValue: undefined,
      },
    }, Object.keys({ credential, proof }).sort());

    // Hash the data
    const messageHash = sha256(new TextEncoder().encode(dataToSign));

    // Decode the public key from multibase
    const publicKeyBytes = decodeMultibaseKey(publicKey);

    // Determine the key type
    const keyType = getKeyType(publicKey);

    // Verify based on key type
    if (keyType === 'secp256k1') {
      return verifySecp256k1Signature(messageHash, signature, publicKeyBytes);
    } else if (keyType === 'ed25519') {
      return verifyEd25519Signature(messageHash, signature, publicKeyBytes);
    } else {
      throw new Error(`Unsupported key type: ${keyType}`);
    }
  } catch (error) {
    console.error('Error verifying credential signature:', error);
    return false;
  }
}

/**
 * Verify a secp256k1 signature
 */
function verifySecp256k1Signature(
  messageHash: Uint8Array,
  signature: string,
  publicKey: Uint8Array
): boolean {
  try {
    // Remove '0x' prefix if present
    const cleanSig = signature.startsWith('0x') ? signature.slice(2) : signature;

    // Convert signature to bytes
    const sigBytes = hexToBytes(cleanSig);

    // Verify with secp256k1
    return secp256k1.verify(sigBytes, messageHash, publicKey);
  } catch (error) {
    console.error('Error verifying secp256k1 signature:', error);
    return false;
  }
}

/**
 * Verify an ed25519 signature
 */
function verifyEd25519Signature(
  messageHash: Uint8Array,
  signature: string,
  publicKey: Uint8Array
): boolean {
  try {
    // Remove '0x' or 'z' prefix if present
    let cleanSig = signature;
    if (cleanSig.startsWith('0x')) {
      cleanSig = cleanSig.slice(2);
    } else if (cleanSig.startsWith('z')) {
      cleanSig = cleanSig.slice(1);
    }

    // Convert signature to bytes
    const sigBytes = hexToBytes(cleanSig);

    // Verify with ed25519
    return ed25519.verify(sigBytes, messageHash, publicKey);
  } catch (error) {
    console.error('Error verifying ed25519 signature:', error);
    return false;
  }
}

/**
 * Decode a multibase encoded key
 * Returns the raw key bytes
 */
function decodeMultibaseKey(multibaseKey: string): Uint8Array {
  // Multibase format: first character is the encoding, rest is the data
  const encoding = multibaseKey[0];

  if (encoding !== 'z') {
    throw new Error(`Unsupported multibase encoding: ${encoding}`);
  }

  // Remove the encoding character and decode from base58
  const encoded = multibaseKey.slice(1);
  return base58Decode(encoded);
}

/**
 * Get the key type from a multibase encoded key
 */
function getKeyType(multibaseKey: string): 'secp256k1' | 'ed25519' {
  // This is a simplified implementation
  // In practice, you'd check the multicodec prefix in the decoded key
  // For now, we'll use a heuristic based on key length
  const decoded = decodeMultibaseKey(multibaseKey);

  // secp256k1 public keys are 33 bytes (compressed) or 65 bytes (uncompressed)
  // ed25519 public keys are 32 bytes
  if (decoded.length === 32 || decoded.length === 34) {
    // 32 bytes + 2 byte multicodec prefix for ed25519
    return 'ed25519';
  } else if (decoded.length === 33 || decoded.length === 35 || decoded.length === 65) {
    // 33/65 bytes + 2 byte multicodec prefix for secp256k1
    return 'secp256k1';
  }

  throw new Error(`Cannot determine key type from length: ${decoded.length}`);
}

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Base58 decode (Bitcoin alphabet)
 */
function base58Decode(input: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;

  let num = 0n;
  for (const char of input) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * BASE + BigInt(digit);
  }

  // Convert to bytes
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num = num / 256n;
  }

  // Add leading zeros
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Extract public key from DID document
 */
export function extractPublicKeyFromDID(
  didDocument: any,
  verificationMethodId: string
): string | null {
  try {
    const verificationMethod = didDocument.verificationMethod?.find(
      (vm: any) => vm.id === verificationMethodId
    );

    if (!verificationMethod) {
      return null;
    }

    return verificationMethod.publicKeyMultibase || null;
  } catch (error) {
    console.error('Error extracting public key from DID:', error);
    return null;
  }
}
