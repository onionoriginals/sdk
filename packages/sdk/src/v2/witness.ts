/**
 * Witness - Third-party attestation for Originals
 * 
 * Witnesses provide independent verification that an event occurred
 * at a specific point in time. This adds trust without requiring
 * the witness to be online during verification.
 */

import type { LogEntry, Proof, WitnessProof, Signer } from './types'
import { hash } from './crypto'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Witness service interface
 */
export interface WitnessService {
  /** Service identifier (URL or DID) */
  id: string
  
  /** Request a witness proof for an event */
  witness(event: LogEntry): Promise<WitnessProof>
  
  /** Verify a witness proof (optional - can be done offline with public key) */
  verifyProof?(proof: WitnessProof, event: LogEntry): Promise<boolean>
}

/**
 * Witness configuration
 */
export interface WitnessConfig {
  /** Minimum number of witnesses required */
  threshold?: number
  /** List of trusted witness services */
  witnesses?: WitnessService[]
}

/**
 * Result of witnessing an event
 */
export interface WitnessResult {
  /** The event that was witnessed */
  event: LogEntry
  /** Witness proofs collected */
  proofs: WitnessProof[]
  /** Whether threshold was met */
  thresholdMet: boolean
  /** Any errors from witness services */
  errors?: Array<{ witness: string; error: string }>
}

// =============================================================================
// WITNESS OPERATIONS
// =============================================================================

/**
 * Request witness proofs for an event
 */
export async function witnessEvent(
  event: LogEntry,
  witnesses: WitnessService[],
  options?: { threshold?: number; timeout?: number }
): Promise<WitnessResult> {
  const threshold = options?.threshold ?? 1
  const timeout = options?.timeout ?? 30000

  const proofs: WitnessProof[] = []
  const errors: Array<{ witness: string; error: string }> = []

  // Request proofs from all witnesses in parallel
  const results = await Promise.allSettled(
    witnesses.map(async (witness) => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      try {
        const proof = await witness.witness(event)
        clearTimeout(timeoutId)
        return { witness: witness.id, proof }
      } catch (e) {
        clearTimeout(timeoutId)
        throw { witness: witness.id, error: e }
      }
    })
  )

  // Collect successful proofs and errors
  for (const result of results) {
    if (result.status === 'fulfilled') {
      proofs.push(result.value.proof)
    } else {
      const err = result.reason as { witness: string; error: unknown }
      errors.push({
        witness: err.witness,
        error: err.error instanceof Error ? err.error.message : String(err.error),
      })
    }
  }

  return {
    event,
    proofs,
    thresholdMet: proofs.length >= threshold,
    errors: errors.length > 0 ? errors : undefined,
  }
}

/**
 * Add witness proofs to an event
 */
export function addWitnessProofs(
  event: LogEntry,
  witnessProofs: WitnessProof[]
): LogEntry {
  return {
    ...event,
    proof: [...event.proof, ...witnessProofs],
  }
}

/**
 * Extract witness proofs from an event
 */
export function getWitnessProofs(event: LogEntry): WitnessProof[] {
  return event.proof.filter(isWitnessProof)
}

/**
 * Check if a proof is a witness proof
 */
export function isWitnessProof(proof: Proof): proof is WitnessProof {
  return 'witnessedAt' in proof
}

/**
 * Count witness proofs in an event
 */
export function countWitnessProofs(event: LogEntry): number {
  return getWitnessProofs(event).length
}

// =============================================================================
// HTTP WITNESS
// =============================================================================

/**
 * HTTP-based witness service
 */
export class HttpWitness implements WitnessService {
  constructor(
    public readonly id: string,
    private endpoint: string,
    private options?: { headers?: Record<string, string> }
  ) {}

  async witness(event: LogEntry): Promise<WitnessProof> {
    const eventHash = hash(event)

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.options?.headers,
      },
      body: JSON.stringify({
        event,
        eventHash,
        requestedAt: new Date().toISOString(),
      }),
    })

    if (!response.ok) {
      throw new Error(`Witness service error: ${response.status}`)
    }

    const result = await response.json() as { proof: WitnessProof }
    return result.proof
  }
}

// =============================================================================
// LOCAL WITNESS (for testing/self-attestation)
// =============================================================================

/**
 * Local witness using a signer (for testing or self-attestation)
 */
export class LocalWitness implements WitnessService {
  constructor(
    public readonly id: string,
    private signer: Signer
  ) {}

  async witness(event: LogEntry): Promise<WitnessProof> {
    const now = new Date().toISOString()
    const proof = await this.signer.sign(event)

    return {
      ...proof,
      witnessedAt: now,
    }
  }
}

// =============================================================================
// BITCOIN WITNESS
// =============================================================================

/**
 * Bitcoin timestamp witness (uses opentimestamps or similar)
 * This provides the strongest form of witnessing - anchored to Bitcoin's blockchain
 */
export interface BitcoinWitnessConfig {
  /** OpenTimestamps calendar URL */
  calendarUrl?: string
  /** Whether to wait for Bitcoin confirmation */
  waitForConfirmation?: boolean
}

/**
 * Create a Bitcoin timestamp witness proof
 * Note: This is a simplified interface - real implementation would use opentimestamps
 */
export async function createBitcoinWitness(
  event: LogEntry,
  config?: BitcoinWitnessConfig
): Promise<{
  timestamp: string
  merkleRoot?: string
  bitcoinBlockHeight?: number
  opentimestampsProof?: Uint8Array
}> {
  const eventHash = hash(event)
  const now = new Date().toISOString()

  // In a real implementation, this would:
  // 1. Submit hash to OpenTimestamps calendar
  // 2. Wait for Bitcoin block inclusion
  // 3. Return the merkle proof

  return {
    timestamp: now,
    // These would be populated by actual Bitcoin anchoring
    merkleRoot: undefined,
    bitcoinBlockHeight: undefined,
    opentimestampsProof: undefined,
  }
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Verify witness proofs on an event
 */
export async function verifyWitnessProofs(
  event: LogEntry,
  options?: {
    /** Minimum witnesses required */
    threshold?: number
    /** Trusted witness IDs (if empty, all are trusted) */
    trustedWitnesses?: string[]
  }
): Promise<{
  valid: boolean
  witnessCount: number
  trustedCount: number
  errors: string[]
}> {
  const witnessProofs = getWitnessProofs(event)
  const threshold = options?.threshold ?? 1
  const trustedWitnesses = options?.trustedWitnesses

  const errors: string[] = []
  let trustedCount = 0

  for (const proof of witnessProofs) {
    // Check if witness is trusted
    if (trustedWitnesses && trustedWitnesses.length > 0) {
      const witnessId = proof.method.split('#')[0]
      if (trustedWitnesses.includes(witnessId)) {
        trustedCount++
      }
    } else {
      // If no trusted list, all witnesses count
      trustedCount++
    }

    // Verify timestamp is valid
    const witnessedAt = new Date(proof.witnessedAt)
    if (isNaN(witnessedAt.getTime())) {
      errors.push(`Invalid witnessedAt timestamp: ${proof.witnessedAt}`)
    }
  }

  return {
    valid: trustedCount >= threshold && errors.length === 0,
    witnessCount: witnessProofs.length,
    trustedCount,
    errors,
  }
}
