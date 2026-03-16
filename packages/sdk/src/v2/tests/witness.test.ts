/**
 * Witness Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  witnessEvent,
  addWitnessProofs,
  getWitnessProofs,
  isWitnessProof,
  countWitnessProofs,
  verifyWitnessProofs,
  LocalWitness,
  type WitnessService,
} from '../witness'
import { create } from '../originals'
import { generateKeyPair, createSigner } from '../crypto'
import type { LogEntry, WitnessProof, Resource } from '../types'

// =============================================================================
// FIXTURES
// =============================================================================

async function createTestEvent(): Promise<LogEntry> {
  const keyPair = await generateKeyPair('Ed25519')
  const signer = createSigner(keyPair, `did:key:${keyPair.publicKey}#key-1`)
  
  const resource: Resource = {
    id: 'main',
    type: 'image',
    hash: 'zQmTest123',
    mediaType: 'image/png',
  }

  const original = await create({ resources: [resource], signer })
  return original.log.events[0]
}

async function createLocalWitness(id: string): Promise<LocalWitness> {
  const keyPair = await generateKeyPair('Ed25519')
  const signer = createSigner(keyPair, `${id}#key-1`)
  return new LocalWitness(id, signer)
}

// =============================================================================
// LOCAL WITNESS
// =============================================================================

describe('LocalWitness', () => {
  test('creates witness proof', async () => {
    const event = await createTestEvent()
    const witness = await createLocalWitness('did:key:witness1')

    const proof = await witness.witness(event)

    expect(proof.witnessedAt).toBeDefined()
    expect(proof.type).toBe('DataIntegrityProof')
    expect(proof.value).toBeDefined()
  })
})

// =============================================================================
// WITNESS EVENT
// =============================================================================

describe('witnessEvent', () => {
  test('collects proofs from multiple witnesses', async () => {
    const event = await createTestEvent()
    const witnesses = await Promise.all([
      createLocalWitness('did:key:witness1'),
      createLocalWitness('did:key:witness2'),
    ])

    const result = await witnessEvent(event, witnesses, { threshold: 2 })

    expect(result.proofs).toHaveLength(2)
    expect(result.thresholdMet).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  test('reports threshold not met', async () => {
    const event = await createTestEvent()
    const witnesses = await Promise.all([
      createLocalWitness('did:key:witness1'),
    ])

    const result = await witnessEvent(event, witnesses, { threshold: 2 })

    expect(result.proofs).toHaveLength(1)
    expect(result.thresholdMet).toBe(false)
  })

  test('handles witness errors gracefully', async () => {
    const event = await createTestEvent()
    
    // Create a failing witness
    const failingWitness: WitnessService = {
      id: 'did:key:failing',
      async witness() {
        throw new Error('Service unavailable')
      },
    }
    
    const goodWitness = await createLocalWitness('did:key:good')

    const result = await witnessEvent(event, [failingWitness, goodWitness], { threshold: 1 })

    expect(result.proofs).toHaveLength(1)
    expect(result.thresholdMet).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(result.errors![0].witness).toBe('did:key:failing')
  })
})

// =============================================================================
// PROOF MANIPULATION
// =============================================================================

describe('addWitnessProofs', () => {
  test('adds witness proofs to event', async () => {
    const event = await createTestEvent()
    const witness = await createLocalWitness('did:key:witness1')
    const witnessProof = await witness.witness(event)

    const updatedEvent = addWitnessProofs(event, [witnessProof])

    expect(updatedEvent.proof).toHaveLength(2) // Original + witness
    expect(updatedEvent.proof[1]).toBe(witnessProof)
  })
})

describe('getWitnessProofs', () => {
  test('extracts only witness proofs', async () => {
    const event = await createTestEvent()
    const witness = await createLocalWitness('did:key:witness1')
    const witnessProof = await witness.witness(event)
    const updatedEvent = addWitnessProofs(event, [witnessProof])

    const witnessProofs = getWitnessProofs(updatedEvent)

    expect(witnessProofs).toHaveLength(1)
    expect(witnessProofs[0].witnessedAt).toBeDefined()
  })

  test('returns empty for event without witnesses', async () => {
    const event = await createTestEvent()
    const witnessProofs = getWitnessProofs(event)
    expect(witnessProofs).toHaveLength(0)
  })
})

describe('isWitnessProof', () => {
  test('identifies witness proofs', async () => {
    const witness = await createLocalWitness('did:key:witness1')
    const event = await createTestEvent()
    const witnessProof = await witness.witness(event)

    expect(isWitnessProof(witnessProof)).toBe(true)
    expect(isWitnessProof(event.proof[0])).toBe(false)
  })
})

describe('countWitnessProofs', () => {
  test('counts witness proofs', async () => {
    const event = await createTestEvent()
    expect(countWitnessProofs(event)).toBe(0)

    const witnesses = await Promise.all([
      createLocalWitness('did:key:w1'),
      createLocalWitness('did:key:w2'),
    ])
    const proofs = await Promise.all(witnesses.map(w => w.witness(event)))
    const updatedEvent = addWitnessProofs(event, proofs)

    expect(countWitnessProofs(updatedEvent)).toBe(2)
  })
})

// =============================================================================
// VERIFICATION
// =============================================================================

describe('verifyWitnessProofs', () => {
  test('verifies valid witness proofs', async () => {
    const event = await createTestEvent()
    const witness = await createLocalWitness('did:key:witness1')
    const witnessProof = await witness.witness(event)
    const updatedEvent = addWitnessProofs(event, [witnessProof])

    const result = await verifyWitnessProofs(updatedEvent, { threshold: 1 })

    expect(result.valid).toBe(true)
    expect(result.witnessCount).toBe(1)
    expect(result.trustedCount).toBe(1)
  })

  test('fails when threshold not met', async () => {
    const event = await createTestEvent()
    const witness = await createLocalWitness('did:key:witness1')
    const witnessProof = await witness.witness(event)
    const updatedEvent = addWitnessProofs(event, [witnessProof])

    const result = await verifyWitnessProofs(updatedEvent, { threshold: 2 })

    expect(result.valid).toBe(false)
    expect(result.witnessCount).toBe(1)
  })

  test('filters by trusted witnesses', async () => {
    const event = await createTestEvent()
    const trustedWitness = await createLocalWitness('did:key:trusted')
    const untrustedWitness = await createLocalWitness('did:key:untrusted')
    
    const proofs = await Promise.all([
      trustedWitness.witness(event),
      untrustedWitness.witness(event),
    ])
    const updatedEvent = addWitnessProofs(event, proofs)

    const result = await verifyWitnessProofs(updatedEvent, {
      threshold: 1,
      trustedWitnesses: ['did:key:trusted'],
    })

    expect(result.valid).toBe(true)
    expect(result.witnessCount).toBe(2)
    expect(result.trustedCount).toBe(1)
  })
})
