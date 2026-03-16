/**
 * Crypto - Signing, verification, hashing
 */

import type { Proof, KeyPair, KeyType, Signer, Verifier } from './types'
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js'

// =============================================================================
// HASHING
// =============================================================================

/**
 * Hash any data, return multibase-encoded multihash
 */
export function hash(data: unknown): string {
  const json = canonicalize(data)
  const bytes = new TextEncoder().encode(json)
  const digest = sha256(bytes)
  // Multibase (base58btc) + Multihash (sha2-256)
  return encodeMultibase(digest, 'sha2-256')
}

/**
 * Verify a hash matches data
 */
export function verifyHash(data: unknown, expected: string): boolean {
  return hash(data) === expected
}

// =============================================================================
// KEYS
// =============================================================================

/**
 * Generate a key pair
 */
export async function generateKeyPair(type: KeyType = 'Ed25519'): Promise<KeyPair> {
  switch (type) {
    case 'Ed25519':
      return generateEd25519()
    case 'secp256k1':
      return generateSecp256k1()
    case 'P-256':
      return generateP256()
    default:
      throw new Error(`Unsupported key type: ${type}`)
  }
}

async function generateEd25519(): Promise<KeyPair> {
  const ed = await import('@noble/ed25519')
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  return {
    type: 'Ed25519',
    privateKey: encodeMultibase(privateKey, 'ed25519-priv'),
    publicKey: encodeMultibase(publicKey, 'ed25519-pub'),
  }
}

async function generateSecp256k1(): Promise<KeyPair> {
  const secp = await import('@noble/secp256k1')
  const privateKey = secp.utils.randomPrivateKey()
  const publicKey = secp.getPublicKey(privateKey, true)
  return {
    type: 'secp256k1',
    privateKey: encodeMultibase(privateKey, 'secp256k1-priv'),
    publicKey: encodeMultibase(publicKey, 'secp256k1-pub'),
  }
}

async function generateP256(): Promise<KeyPair> {
  const p256 = await import('@noble/curves/p256')
  const privateKey = p256.p256.utils.randomPrivateKey()
  const publicKey = p256.p256.getPublicKey(privateKey, true)
  return {
    type: 'P-256',
    privateKey: encodeMultibase(privateKey, 'p256-priv'),
    publicKey: encodeMultibase(publicKey, 'p256-pub'),
  }
}

// =============================================================================
// SIGNING
// =============================================================================

/**
 * Create a signer from a key pair
 */
export function createSigner(keyPair: KeyPair, verificationMethod: string): Signer {
  return {
    async sign(data: unknown): Promise<Proof> {
      const message = new TextEncoder().encode(canonicalize(data))
      const signature = await signBytes(message, keyPair)
      
      return {
        type: 'DataIntegrityProof',
        suite: getSuite(keyPair.type),
        created: new Date().toISOString(),
        method: verificationMethod,
        purpose: 'assertionMethod',
        value: signature,
      }
    },
    getVerificationMethod() {
      return verificationMethod
    },
  }
}

async function signBytes(message: Uint8Array, keyPair: KeyPair): Promise<string> {
  const privateKey = decodeMultibase(keyPair.privateKey)

  switch (keyPair.type) {
    case 'Ed25519': {
      const ed = await import('@noble/ed25519')
      const sig = await ed.signAsync(message, privateKey)
      return encodeMultibase(sig, 'sig')
    }
    case 'secp256k1': {
      const secp = await import('@noble/secp256k1')
      const sig = await secp.signAsync(sha256(message), privateKey)
      return encodeMultibase(sig.toCompactRawBytes(), 'sig')
    }
    case 'P-256': {
      const p256 = await import('@noble/curves/p256')
      const sig = p256.p256.sign(sha256(message), privateKey)
      return encodeMultibase(sig.toCompactRawBytes(), 'sig')
    }
    default:
      throw new Error(`Unsupported key type: ${keyPair.type}`)
  }
}

function getSuite(keyType: KeyType): string {
  switch (keyType) {
    case 'Ed25519': return 'eddsa-jcs-2022'
    case 'secp256k1': return 'ecdsa-jcs-2019'
    case 'P-256': return 'ecdsa-jcs-2019'
  }
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Create a verifier from a public key
 */
export function createVerifier(publicKey: string, keyType: KeyType): Verifier {
  return {
    async verify(proof: Proof, data: unknown): Promise<boolean> {
      return verifyProof(proof, data, publicKey, keyType)
    },
  }
}

/**
 * Verify a proof against data
 */
export async function verifyProof(
  proof: Proof,
  data: unknown,
  publicKey: string,
  keyType: KeyType
): Promise<boolean> {
  const message = new TextEncoder().encode(canonicalize(data))
  const signature = decodeMultibase(proof.value)
  const pubKeyBytes = decodeMultibase(publicKey)

  try {
    switch (keyType) {
      case 'Ed25519': {
        const ed = await import('@noble/ed25519')
        return await ed.verifyAsync(signature, message, pubKeyBytes)
      }
      case 'secp256k1': {
        const secp = await import('@noble/secp256k1')
        return secp.verify(signature, sha256(message), pubKeyBytes)
      }
      case 'P-256': {
        const p256 = await import('@noble/curves/p256')
        return p256.p256.verify(signature, sha256(message), pubKeyBytes)
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

// =============================================================================
// ENCODING
// =============================================================================

// Multibase prefixes
const MULTIBASE_BASE58BTC = 'z'

// Multicodec prefixes (simplified)
const MULTICODEC: Record<string, Uint8Array> = {
  'sha2-256': new Uint8Array([0x12, 0x20]), // multihash
  'ed25519-pub': new Uint8Array([0xed, 0x01]),
  'ed25519-priv': new Uint8Array([0x80, 0x26]),
  'secp256k1-pub': new Uint8Array([0xe7, 0x01]),
  'secp256k1-priv': new Uint8Array([0x81, 0x26]),
  'p256-pub': new Uint8Array([0x80, 0x24]),
  'p256-priv': new Uint8Array([0x86, 0x26]),
  'sig': new Uint8Array([]), // no prefix for signatures
}

function encodeMultibase(bytes: Uint8Array, codec: string): string {
  const prefix = MULTICODEC[codec] || new Uint8Array([])
  const combined = new Uint8Array(prefix.length + bytes.length)
  combined.set(prefix)
  combined.set(bytes, prefix.length)
  return MULTIBASE_BASE58BTC + base58btc.encode(combined)
}

function decodeMultibase(encoded: string): Uint8Array {
  if (!encoded.startsWith(MULTIBASE_BASE58BTC)) {
    throw new Error('Unsupported multibase encoding')
  }
  const bytes = base58btc.decode(encoded.slice(1))
  
  // Strip multicodec prefix based on first bytes
  // ed25519-pub: 0xed 0x01 (2 bytes)
  // ed25519-priv: 0x80 0x26 (2 bytes)
  // secp256k1-pub: 0xe7 0x01 (2 bytes)
  // secp256k1-priv: 0x81 0x26 (2 bytes)
  // sha2-256 multihash: 0x12 0x20 (2 bytes)
  // sig: no prefix
  
  if (bytes.length > 2) {
    // Check for known prefixes and strip them
    const prefix = (bytes[0] << 8) | bytes[1]
    const knownPrefixes = [
      0xed01, // ed25519-pub
      0x8026, // ed25519-priv
      0xe701, // secp256k1-pub
      0x8126, // secp256k1-priv
      0x8024, // p256-pub
      0x8626, // p256-priv
      0x1220, // sha2-256
    ]
    if (knownPrefixes.includes(prefix)) {
      return bytes.slice(2)
    }
  }
  
  return bytes
}

// =============================================================================
// PRIMITIVES
// =============================================================================

/**
 * SHA-256 hash (sync, uses noble/hashes)
 */
function sha256(data: Uint8Array): Uint8Array {
  return sha256Hash(data)
}

/**
 * Canonicalize JSON (deterministic serialization)
 */
function canonicalize(data: unknown): string {
  return JSON.stringify(data, Object.keys(data as object).sort())
}

// Base58btc codec (simplified)
const base58btc = {
  alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  
  encode(bytes: Uint8Array): string {
    if (bytes.length === 0) return ''
    
    // Count leading zeros
    let zeros = 0
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++
    
    // Convert to base58
    const size = Math.ceil(bytes.length * 138 / 100) + 1
    const b58 = new Uint8Array(size)
    let length = 0
    
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i]
      let j = 0
      for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
        carry += 256 * b58[k]
        b58[k] = carry % 58
        carry = Math.floor(carry / 58)
      }
      length = j
    }
    
    // Skip leading zeros in base58
    let i = size - length
    while (i < size && b58[i] === 0) i++
    
    // Build string
    let str = '1'.repeat(zeros)
    for (; i < size; i++) str += this.alphabet[b58[i]]
    return str
  },
  
  decode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0)
    
    // Count leading '1's
    let zeros = 0
    while (zeros < str.length && str[zeros] === '1') zeros++
    
    // Allocate enough space
    const size = Math.ceil(str.length * 733 / 1000) + 1
    const bytes = new Uint8Array(size)
    let length = 0
    
    for (let i = zeros; i < str.length; i++) {
      const idx = this.alphabet.indexOf(str[i])
      if (idx === -1) throw new Error('Invalid base58 character')
      
      let carry = idx
      let j = 0
      for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
        carry += 58 * bytes[k]
        bytes[k] = carry % 256
        carry = Math.floor(carry / 256)
      }
      length = j
    }
    
    // Skip leading zeros in result
    let i = size - length
    while (i < size && bytes[i] === 0) i++
    
    // Build result with leading zeros
    const result = new Uint8Array(zeros + (size - i))
    result.fill(0, 0, zeros)
    result.set(bytes.slice(i), zeros)
    return result
  },
}
