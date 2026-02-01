/**
 * Ordinals - Bitcoin inscription layer (did:btco)
 * 
 * Provides inscription creation, fetching, and transfer for the btco layer.
 */

import type { Original, EventLog, Resource } from './types'
import { createBtcoDID } from './did'
import { hash } from './crypto'

// =============================================================================
// PROVIDER INTERFACE
// =============================================================================

/**
 * Ordinals provider interface - abstracts inscription services
 * (e.g., ord server, Hiro, custom indexer)
 */
export interface OrdinalsProvider {
  /** Create a new inscription */
  createInscription(params: CreateInscriptionParams): Promise<InscriptionResult>
  
  /** Get inscription by ID */
  getInscription(id: string): Promise<Inscription | null>
  
  /** Transfer an inscription to a new address */
  transferInscription?(id: string, toAddress: string, feeRate?: number): Promise<TransferResult>
  
  /** Broadcast a raw transaction */
  broadcastTransaction?(txHex: string): Promise<string>
  
  /** Estimate fee rate (sats/vB) */
  estimateFeeRate?(targetBlocks?: number): Promise<number>
}

export interface CreateInscriptionParams {
  content: Uint8Array
  contentType: string
  feeRate?: number
  metadata?: Record<string, unknown>
}

export interface InscriptionResult {
  inscriptionId: string
  txid: string
  vout: number
  satoshi?: string
}

export interface Inscription {
  inscriptionId: string
  content: Uint8Array
  contentType: string
  txid: string
  vout: number
  satoshi?: string
  blockHeight?: number
}

export interface TransferResult {
  txid: string
  fee: number
}

// =============================================================================
// INSCRIBE ORIGINAL
// =============================================================================

export interface InscribeOriginalOptions {
  original: Original
  provider: OrdinalsProvider
  feeRate?: number
  /** Format: 'json' | 'cbor' (default: 'cbor' for smaller size) */
  format?: 'json' | 'cbor'
}

export interface InscribeOriginalResult {
  did: string
  inscriptionId: string
  txid: string
  vout: number
}

/**
 * Inscribe an Original onto Bitcoin
 */
export async function inscribeOriginal(
  options: InscribeOriginalOptions
): Promise<InscribeOriginalResult> {
  const { original, provider, feeRate, format = 'cbor' } = options

  // Serialize Original
  const content = format === 'cbor'
    ? await serializeCBOR(original)
    : serializeJSON(original)

  const contentType = format === 'cbor'
    ? 'application/cbor'
    : 'application/json'

  const result = await provider.createInscription({
    content,
    contentType,
    feeRate,
    metadata: {
      protocol: 'originals',
      version: '2.0',
      originalDid: original.did,
      layer: original.layer,
    },
  })

  return {
    did: createBtcoDID(result.txid, result.vout),
    inscriptionId: result.inscriptionId,
    txid: result.txid,
    vout: result.vout,
  }
}

// =============================================================================
// INSCRIBE EVENT LOG
// =============================================================================

export interface InscribeLogOptions {
  log: EventLog
  provider: OrdinalsProvider
  feeRate?: number
  /** Reference to parent Original inscription */
  parentInscriptionId?: string
}

/**
 * Inscribe just the event log (for updates after initial inscription)
 */
export async function inscribeEventLog(
  options: InscribeLogOptions
): Promise<InscribeOriginalResult> {
  const { log, provider, feeRate } = options

  const content = await serializeCBOR(log)

  const result = await provider.createInscription({
    content,
    contentType: 'application/cbor',
    feeRate,
    metadata: {
      protocol: 'originals-log',
      version: '2.0',
      events: log.events.length,
    },
  })

  return {
    did: createBtcoDID(result.txid, result.vout),
    inscriptionId: result.inscriptionId,
    txid: result.txid,
    vout: result.vout,
  }
}

// =============================================================================
// FETCH
// =============================================================================

/**
 * Fetch an Original from Bitcoin by inscription ID
 */
export async function fetchOriginal(
  inscriptionId: string,
  provider: OrdinalsProvider
): Promise<Original | null> {
  const inscription = await provider.getInscription(inscriptionId)
  if (!inscription) return null

  if (inscription.contentType === 'application/cbor') {
    return deserializeCBOR<Original>(inscription.content)
  } else if (inscription.contentType === 'application/json') {
    return deserializeJSON<Original>(inscription.content)
  }

  return null
}

/**
 * Fetch an Original by did:btco
 */
export async function fetchOriginalByDID(
  did: string,
  provider: OrdinalsProvider
): Promise<Original | null> {
  const inscriptionId = didToInscriptionId(did)
  if (!inscriptionId) return null
  return fetchOriginal(inscriptionId, provider)
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert did:btco to inscription ID
 */
export function didToInscriptionId(did: string): string | null {
  if (!did.startsWith('did:btco:')) return null
  return did.replace('did:btco:', '')
}

/**
 * Parse inscription ID to components
 */
export function parseInscriptionId(id: string): { txid: string; index: number } | null {
  const match = id.match(/^([a-f0-9]{64})i(\d+)$/)
  if (!match) return null
  return { txid: match[1], index: parseInt(match[2], 10) }
}

/**
 * Estimate inscription fee
 */
export function estimateInscriptionFee(
  contentSize: number,
  feeRate: number
): number {
  // Rough estimate:
  // - Base reveal tx: ~150 vbytes
  // - Witness data: content / 4 (witness discount)
  // - Commit tx: ~150 vbytes
  const revealSize = 150 + Math.ceil(contentSize / 4)
  const commitSize = 150
  return (revealSize + commitSize) * feeRate
}

// =============================================================================
// SERIALIZATION
// =============================================================================

function serializeJSON(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data))
}

function deserializeJSON<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

async function serializeCBOR(data: unknown): Promise<Uint8Array> {
  // Use dynamic import to avoid bundling issues
  try {
    const cbor = await import('cbor-js')
    // cbor-js encode returns ArrayBuffer, convert to Uint8Array
    const buffer = cbor.encode(data) as ArrayBuffer
    return new Uint8Array(buffer)
  } catch {
    // Fallback to JSON if CBOR not available
    console.warn('cbor-js not available, falling back to JSON')
    return serializeJSON(data)
  }
}

async function deserializeCBOR<T>(bytes: Uint8Array): Promise<T> {
  try {
    const cbor = await import('cbor-js')
    return cbor.decode(bytes.buffer) as T
  } catch {
    // Fallback to JSON
    return deserializeJSON<T>(bytes)
  }
}

// =============================================================================
// MOCK PROVIDER (for testing)
// =============================================================================

/**
 * Mock ordinals provider for testing
 */
export class MockOrdinalsProvider implements OrdinalsProvider {
  private inscriptions = new Map<string, Inscription>()
  private feeRate = 5

  async createInscription(params: CreateInscriptionParams): Promise<InscriptionResult> {
    const txid = randomHex(64)
    const vout = 0
    const inscriptionId = `${txid}i${vout}`

    const inscription: Inscription = {
      inscriptionId,
      content: params.content,
      contentType: params.contentType,
      txid,
      vout,
      blockHeight: 1,
    }

    this.inscriptions.set(inscriptionId, inscription)

    return { inscriptionId, txid, vout }
  }

  async getInscription(id: string): Promise<Inscription | null> {
    return this.inscriptions.get(id) || null
  }

  async estimateFeeRate(): Promise<number> {
    return this.feeRate
  }

  // For testing: pre-populate inscriptions
  addInscription(inscription: Inscription): void {
    this.inscriptions.set(inscription.inscriptionId, inscription)
  }
}

function randomHex(length: number): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)]
  }
  return result
}
