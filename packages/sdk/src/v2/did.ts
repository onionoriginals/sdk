/**
 * DID - Decentralized Identifier operations
 */

import type { DIDDocument, VerificationMethod, Resource, KeyPair, Layer } from './types'
import { hash, generateKeyPair } from './crypto'

// =============================================================================
// CREATE
// =============================================================================

/**
 * Create a did:peer from resources (self-certifying)
 */
export async function createPeerDID(resources: Resource[]): Promise<string> {
  const contentHash = hash(resources)
  // did:peer method 0 - genesis doc embedded
  return `did:peer:0${contentHash}`
}

/**
 * Create a did:webvh identifier
 */
export function createWebVHDID(domain: string, scid: string): string {
  return `did:webvh:${domain}:${scid}`
}

/**
 * Create a did:btco identifier from inscription
 */
export function createBtcoDID(txid: string, vout: number = 0): string {
  return `did:btco:${txid}i${vout}`
}

// =============================================================================
// DOCUMENTS
// =============================================================================

/**
 * Create a minimal DID document
 */
export async function createDIDDocument(
  did: string,
  keyPair?: KeyPair
): Promise<{ doc: DIDDocument; keyPair: KeyPair }> {
  const kp = keyPair || await generateKeyPair('Ed25519')
  
  const vmId = `${did}#key-1`
  const vm: VerificationMethod = {
    id: vmId,
    type: getKeyType(kp.type),
    controller: did,
    publicKeyMultibase: kp.publicKey,
  }

  const doc: DIDDocument = {
    id: did,
    verificationMethod: [vm],
    authentication: [vmId],
    assertionMethod: [vmId],
  }

  return { doc, keyPair: kp }
}

function getKeyType(type: string): string {
  switch (type) {
    case 'Ed25519': return 'Ed25519VerificationKey2020'
    case 'secp256k1': return 'EcdsaSecp256k1VerificationKey2019'
    case 'P-256': return 'JsonWebKey2020'
    default: return 'Multikey'
  }
}

// =============================================================================
// RESOLVE
// =============================================================================

/**
 * Resolve a DID to its document
 */
export async function resolveDID(did: string): Promise<DIDDocument | null> {
  const method = parseMethod(did)
  
  switch (method) {
    case 'peer':
      return resolvePeer(did)
    case 'webvh':
      return resolveWebVH(did)
    case 'btco':
      return resolveBtco(did)
    default:
      throw new Error(`Unsupported DID method: ${method}`)
  }
}

function parseMethod(did: string): string {
  const match = did.match(/^did:(\w+):/)
  if (!match) throw new Error(`Invalid DID: ${did}`)
  return match[1]
}

async function resolvePeer(did: string): Promise<DIDDocument | null> {
  // did:peer is self-certifying, document must be provided
  // Return minimal stub - real doc comes from Original
  return { id: did }
}

async function resolveWebVH(did: string): Promise<DIDDocument | null> {
  // Extract domain and path from did:webvh:domain:scid
  const parts = did.replace('did:webvh:', '').split(':')
  if (parts.length < 2) return null
  
  const domain = parts[0]
  const scid = parts[1]
  const url = `https://${domain}/.well-known/did/${scid}/did.json`
  
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json() as DIDDocument
  } catch {
    return null
  }
}

async function resolveBtco(did: string): Promise<DIDDocument | null> {
  // Extract inscription ID from did:btco:txidi0
  const inscriptionId = did.replace('did:btco:', '')
  
  // This would need an ordinals indexer
  // For now, return null - implementation depends on infrastructure
  console.warn('did:btco resolution requires ordinals indexer')
  return null
}

// =============================================================================
// UTILS
// =============================================================================

/**
 * Get the layer type from a DID
 */
export function getLayerFromDID(did: string): Layer {
  const method = parseMethod(did)
  switch (method) {
    case 'peer': return 'peer'
    case 'webvh': return 'webvh'
    case 'btco': return 'btco'
    default: throw new Error(`Unknown DID method: ${method}`)
  }
}

/**
 * Check if a DID is valid
 */
export function isValidDID(did: string): boolean {
  try {
    parseMethod(did)
    return true
  } catch {
    return false
  }
}
