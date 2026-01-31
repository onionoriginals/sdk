/**
 * Originals v2 - Core Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  create,
  update,
  migrate,
  deactivate,
  verify,
} from '../originals'
import {
  generateKeyPair,
  createSigner,
  createVerifier,
  hash,
} from '../crypto'
import type { Resource, Original } from '../types'

// =============================================================================
// FIXTURES
// =============================================================================

async function createTestSigner() {
  const keyPair = await generateKeyPair('Ed25519')
  const did = `did:key:${keyPair.publicKey}`
  const verificationMethod = `${did}#key-1`
  return {
    signer: createSigner(keyPair, verificationMethod),
    verifier: createVerifier(keyPair.publicKey, 'Ed25519'),
    keyPair,
    did,
  }
}

const testResource: Resource = {
  id: 'main',
  type: 'image',
  hash: 'zQmYtUc4iTCbbfVSDNKvtQqrfyezPPnFvE33wFmutw9PBBk',
  mediaType: 'image/png',
  url: ['https://example.com/image.png'],
  size: 1024,
}

// =============================================================================
// CREATE
// =============================================================================

describe('create', () => {
  test('creates an Original on peer layer', async () => {
    const { signer } = await createTestSigner()

    const original = await create({
      resources: [testResource],
      signer,
    })

    expect(original.did).toMatch(/^did:peer:/)
    expect(original.layer).toBe('peer')
    expect(original.resources).toHaveLength(1)
    expect(original.resources[0].id).toBe('main')
    expect(original.log.events).toHaveLength(1)
    expect(original.log.events[0].type).toBe('create')
    expect(original.log.events[0].proof).toHaveLength(1)
  })

  test('includes metadata when provided', async () => {
    const { signer } = await createTestSigner()

    const original = await create({
      resources: [testResource],
      signer,
      metadata: { title: 'Test Original', author: 'Test' },
    })

    const event = original.log.events[0].data as { metadata?: Record<string, unknown> }
    expect(event.metadata).toEqual({ title: 'Test Original', author: 'Test' })
  })
})

// =============================================================================
// UPDATE
// =============================================================================

describe('update', () => {
  test('adds a new log entry', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })

    const newResource: Resource = {
      id: 'thumbnail',
      type: 'image',
      hash: 'zQmXXXXXX',
      mediaType: 'image/jpeg',
    }

    const updated = await update({
      original,
      resources: [newResource],
      signer,
    })

    expect(updated.log.events).toHaveLength(2)
    expect(updated.log.events[1].type).toBe('update')
    expect(updated.log.events[1].prev).toBeDefined()
    expect(updated.resources).toHaveLength(2)
  })

  test('maintains hash chain', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    const updated = await update({ original, metadata: { v: 2 }, signer })

    const expectedPrev = hash(original.log.events[0])
    expect(updated.log.events[1].prev).toBe(expectedPrev)
  })

  test('rejects update on deactivated Original', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    const dead = await deactivate({ original, signer })

    await expect(update({ original: dead, metadata: {}, signer }))
      .rejects.toThrow('Cannot update a deactivated Original')
  })
})

// =============================================================================
// MIGRATE
// =============================================================================

describe('migrate', () => {
  test('migrates peer -> webvh', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })

    const mockPublish = async (did: string) => ({
      did: `did:webvh:example.com:abc123`,
    })

    const migrated = await migrate({
      original,
      toLayer: 'webvh',
      signer,
      publish: mockPublish,
    })

    expect(migrated.layer).toBe('webvh')
    expect(migrated.did).toMatch(/^did:webvh:/)
    expect(migrated.log.events).toHaveLength(2)
    expect(migrated.log.events[1].type).toBe('migrate')
  })

  test('migrates webvh -> btco', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    
    const webvhOriginal: Original = {
      ...original,
      did: 'did:webvh:example.com:abc123',
      layer: 'webvh',
    }

    const mockInscribe = async () => ({
      txid: 'abc123def456',
      did: 'did:btco:abc123def456i0',
    })

    const migrated = await migrate({
      original: webvhOriginal,
      toLayer: 'btco',
      signer,
      inscribe: mockInscribe,
    })

    expect(migrated.layer).toBe('btco')
    expect(migrated.did).toMatch(/^did:btco:/)
  })

  test('rejects invalid layer progression', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    
    const btcoOriginal: Original = {
      ...original,
      did: 'did:btco:abc123i0',
      layer: 'btco',
    }

    await expect(migrate({
      original: btcoOriginal,
      toLayer: 'peer',
      signer,
    })).rejects.toThrow('Cannot migrate from btco to peer')
  })
})

// =============================================================================
// DEACTIVATE
// =============================================================================

describe('deactivate', () => {
  test('marks Original as deactivated', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })

    const dead = await deactivate({
      original,
      reason: 'No longer needed',
      signer,
    })

    expect(dead.deactivated).toBe(true)
    expect(dead.log.events).toHaveLength(2)
    expect(dead.log.events[1].type).toBe('deactivate')
  })

  test('rejects double deactivation', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    const dead = await deactivate({ original, signer })

    await expect(deactivate({ original: dead, signer }))
      .rejects.toThrow('already deactivated')
  })
})

// =============================================================================
// VERIFY
// =============================================================================

describe('verify', () => {
  test('verifies valid Original', async () => {
    const { signer, verifier } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    const updated = await update({ original, metadata: { v: 2 }, signer })

    const result = await verify({ original: updated, verifier })

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('detects broken hash chain', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })
    const updated = await update({ original, metadata: { v: 2 }, signer })

    // Tamper with the hash chain
    const tampered: Original = {
      ...updated,
      log: {
        events: [
          updated.log.events[0],
          { ...updated.log.events[1], prev: 'zTamperedHash' },
        ],
      },
    }

    const result = await verify({ original: tampered })

    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('hash chain'))).toBe(true)
  })

  test('detects missing proof', async () => {
    const { signer } = await createTestSigner()
    const original = await create({ resources: [testResource], signer })

    // Remove proof
    const tampered: Original = {
      ...original,
      log: {
        events: [{ ...original.log.events[0], proof: [] }],
      },
    }

    const result = await verify({ original: tampered })

    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('no proof'))).toBe(true)
  })
})

// =============================================================================
// HASH CHAIN
// =============================================================================

describe('hash chain', () => {
  test('builds proper chain across multiple updates', async () => {
    const { signer } = await createTestSigner()
    
    let original = await create({ resources: [testResource], signer })
    original = await update({ original, metadata: { v: 2 }, signer })
    original = await update({ original, metadata: { v: 3 }, signer })
    original = await update({ original, metadata: { v: 4 }, signer })

    const events = original.log.events
    expect(events).toHaveLength(4)

    // Verify chain
    for (let i = 1; i < events.length; i++) {
      const expectedPrev = hash(events[i - 1])
      expect(events[i].prev).toBe(expectedPrev)
    }
  })
})
