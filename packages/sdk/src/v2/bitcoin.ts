/**
 * Bitcoin - btco layer operations
 */

import type { Original, Resource, EventLog } from './types'
import { createBtcoDID } from './did'
import { hash } from './crypto'

// =============================================================================
// TYPES
// =============================================================================

export interface InscriptionData {
  contentType: string
  content: Uint8Array
  metadata?: Record<string, unknown>
}

export interface InscriptionResult {
  txid: string
  vout: number
  did: string
  inscriptionId: string
}

export interface OrdinalsProvider {
  /** Inscribe data on Bitcoin */
  inscribe(data: InscriptionData): Promise<InscriptionResult>
  /** Fetch inscription content */
  getInscription(inscriptionId: string): Promise<InscriptionData | null>
  /** Get inscription by DID */
  getInscriptionByDID(did: string): Promise<InscriptionData | null>
}

// =============================================================================
// INSCRIBE
// =============================================================================

/**
 * Inscribe an Original onto Bitcoin
 */
export async function inscribeOriginal(
  original: Original,
  provider: OrdinalsProvider
): Promise<InscriptionResult> {
  // Serialize Original to CBOR for compact inscription
  const content = serializeOriginal(original)
  
  const result = await provider.inscribe({
    contentType: 'application/cbor',
    content,
    metadata: {
      protocol: 'originals',
      version: '1.0',
      originalDid: original.did,
    },
  })

  return {
    ...result,
    did: createBtcoDID(result.txid, result.vout),
  }
}

/**
 * Inscribe just the event log (lighter weight)
 */
export async function inscribeEventLog(
  log: EventLog,
  provider: OrdinalsProvider
): Promise<InscriptionResult> {
  const content = serializeEventLog(log)
  
  const result = await provider.inscribe({
    contentType: 'application/cbor',
    content,
    metadata: {
      protocol: 'originals-log',
      version: '1.0',
    },
  })

  return {
    ...result,
    did: createBtcoDID(result.txid, result.vout),
  }
}

// =============================================================================
// FETCH
// =============================================================================

/**
 * Fetch an Original from Bitcoin
 */
export async function fetchOriginal(
  did: string,
  provider: OrdinalsProvider
): Promise<Original | null> {
  const data = await provider.getInscriptionByDID(did)
  if (!data) return null
  
  return deserializeOriginal(data.content)
}

/**
 * Fetch event log from Bitcoin
 */
export async function fetchEventLog(
  inscriptionId: string,
  provider: OrdinalsProvider
): Promise<EventLog | null> {
  const data = await provider.getInscription(inscriptionId)
  if (!data) return null
  
  return deserializeEventLog(data.content)
}

// =============================================================================
// SERIALIZATION
// =============================================================================

// Using JSON for now - switch to CBOR for production
function serializeOriginal(original: Original): Uint8Array {
  const json = JSON.stringify(original)
  return new TextEncoder().encode(json)
}

function deserializeOriginal(bytes: Uint8Array): Original {
  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json) as Original
}

function serializeEventLog(log: EventLog): Uint8Array {
  const json = JSON.stringify(log)
  return new TextEncoder().encode(json)
}

function deserializeEventLog(bytes: Uint8Array): EventLog {
  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json) as EventLog
}

// =============================================================================
// UTILS
// =============================================================================

/**
 * Calculate inscription fee estimate
 */
export function estimateInscriptionFee(
  data: Uint8Array,
  feeRate: number // sats/vbyte
): number {
  // Rough estimate: base tx ~150 vbytes + data in witness
  const baseSize = 150
  const dataSize = Math.ceil(data.length / 4) // witness discount
  return (baseSize + dataSize) * feeRate
}

/**
 * Parse inscription ID to components
 */
export function parseInscriptionId(id: string): { txid: string; index: number } {
  const match = id.match(/^([a-f0-9]{64})i(\d+)$/)
  if (!match) throw new Error(`Invalid inscription ID: ${id}`)
  return { txid: match[1], index: parseInt(match[2], 10) }
}
