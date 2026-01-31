/**
 * Ordinals Integration Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  inscribeOriginal,
  inscribeEventLog,
  fetchOriginal,
  fetchOriginalByDID,
  didToInscriptionId,
  parseInscriptionId,
  estimateInscriptionFee,
  MockOrdinalsProvider,
} from '../ordinals'
import { create } from '../originals'
import { generateKeyPair, createSigner } from '../crypto'
import type { Original, Resource } from '../types'

// =============================================================================
// FIXTURES
// =============================================================================

async function createTestOriginal(): Promise<Original> {
  const keyPair = await generateKeyPair('Ed25519')
  const signer = createSigner(keyPair, `did:key:${keyPair.publicKey}#key-1`)
  
  const resource: Resource = {
    id: 'main',
    type: 'image',
    hash: 'zQmTest123',
    mediaType: 'image/png',
  }

  return create({ resources: [resource], signer })
}

// =============================================================================
// INSCRIBE
// =============================================================================

describe('inscribeOriginal', () => {
  test('inscribes Original and returns DID', async () => {
    const original = await createTestOriginal()
    const provider = new MockOrdinalsProvider()

    const result = await inscribeOriginal({
      original,
      provider,
      format: 'json', // Use JSON for easier testing
    })

    expect(result.did).toMatch(/^did:btco:[a-f0-9]{64}i0$/)
    expect(result.inscriptionId).toMatch(/^[a-f0-9]{64}i0$/)
    expect(result.txid).toHaveLength(64)
    expect(result.vout).toBe(0)
  })

  test('inscribed Original can be fetched', async () => {
    const original = await createTestOriginal()
    const provider = new MockOrdinalsProvider()

    const result = await inscribeOriginal({
      original,
      provider,
      format: 'json',
    })

    const fetched = await fetchOriginal(result.inscriptionId, provider)

    expect(fetched).not.toBeNull()
    expect(fetched!.did).toBe(original.did)
    expect(fetched!.layer).toBe(original.layer)
    expect(fetched!.resources).toHaveLength(1)
  })
})

describe('inscribeEventLog', () => {
  test('inscribes event log', async () => {
    const original = await createTestOriginal()
    const provider = new MockOrdinalsProvider()

    const result = await inscribeEventLog({
      log: original.log,
      provider,
    })

    expect(result.did).toMatch(/^did:btco:/)
    expect(result.inscriptionId).toBeDefined()
  })
})

// =============================================================================
// FETCH
// =============================================================================

describe('fetchOriginalByDID', () => {
  test('fetches by did:btco', async () => {
    const original = await createTestOriginal()
    const provider = new MockOrdinalsProvider()

    const inscribed = await inscribeOriginal({
      original,
      provider,
      format: 'json',
    })

    const fetched = await fetchOriginalByDID(inscribed.did, provider)

    expect(fetched).not.toBeNull()
    expect(fetched!.did).toBe(original.did)
  })

  test('returns null for invalid DID', async () => {
    const provider = new MockOrdinalsProvider()
    const fetched = await fetchOriginalByDID('did:peer:invalid', provider)
    expect(fetched).toBeNull()
  })
})

// =============================================================================
// HELPERS
// =============================================================================

describe('didToInscriptionId', () => {
  test('extracts inscription ID from did:btco', () => {
    const did = 'did:btco:abc123def456i0'
    const id = didToInscriptionId(did)
    expect(id).toBe('abc123def456i0')
  })

  test('returns null for non-btco DID', () => {
    expect(didToInscriptionId('did:peer:123')).toBeNull()
    expect(didToInscriptionId('did:webvh:example.com:abc')).toBeNull()
  })
})

describe('parseInscriptionId', () => {
  test('parses valid inscription ID', () => {
    const id = 'a'.repeat(64) + 'i5'
    const parsed = parseInscriptionId(id)
    
    expect(parsed).not.toBeNull()
    expect(parsed!.txid).toBe('a'.repeat(64))
    expect(parsed!.index).toBe(5)
  })

  test('returns null for invalid ID', () => {
    expect(parseInscriptionId('invalid')).toBeNull()
    expect(parseInscriptionId('abc123i0')).toBeNull() // txid too short
  })
})

describe('estimateInscriptionFee', () => {
  test('estimates fee based on content size', () => {
    const fee1kb = estimateInscriptionFee(1024, 10) // 1KB at 10 sat/vB
    const fee10kb = estimateInscriptionFee(10240, 10) // 10KB at 10 sat/vB
    
    expect(fee10kb).toBeGreaterThan(fee1kb)
    expect(fee1kb).toBeGreaterThan(0)
  })

  test('scales with fee rate', () => {
    const fee5 = estimateInscriptionFee(1024, 5)
    const fee10 = estimateInscriptionFee(1024, 10)
    
    expect(fee10).toBe(fee5 * 2)
  })
})

// =============================================================================
// MOCK PROVIDER
// =============================================================================

describe('MockOrdinalsProvider', () => {
  test('creates and retrieves inscriptions', async () => {
    const provider = new MockOrdinalsProvider()
    
    const result = await provider.createInscription({
      content: new TextEncoder().encode('test'),
      contentType: 'text/plain',
    })

    const fetched = await provider.getInscription(result.inscriptionId)
    
    expect(fetched).not.toBeNull()
    expect(fetched!.contentType).toBe('text/plain')
  })

  test('returns null for unknown inscription', async () => {
    const provider = new MockOrdinalsProvider()
    const fetched = await provider.getInscription('unknown')
    expect(fetched).toBeNull()
  })
})
