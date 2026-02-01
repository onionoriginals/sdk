/**
 * WebVH Integration Tests
 */

import { describe, test, expect, mock } from 'bun:test'
import {
  serializeLog,
  parseLog,
  getHostingPath,
} from '../webvh'
import { generateKeyPair, createSigner } from '../crypto'

// =============================================================================
// LOG SERIALIZATION
// =============================================================================

describe('log serialization', () => {
  const sampleLog = [
    {
      versionId: '1-abc123',
      versionTime: '2024-01-01T00:00:00Z',
      parameters: { method: 'did:webvh:0.5' },
      state: { id: 'did:webvh:example.com:abc123' },
      proof: [{
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        verificationMethod: 'did:key:z6Mk...',
        created: '2024-01-01T00:00:00Z',
        proofValue: 'z...',
        proofPurpose: 'authentication',
      }],
    },
    {
      versionId: '2-def456',
      versionTime: '2024-01-02T00:00:00Z',
      parameters: {},
      state: { id: 'did:webvh:example.com:abc123' },
      proof: [{
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        verificationMethod: 'did:key:z6Mk...',
        created: '2024-01-02T00:00:00Z',
        proofValue: 'z...',
        proofPurpose: 'authentication',
      }],
    },
  ]

  test('serializes log to JSONL', () => {
    const jsonl = serializeLog(sampleLog)
    const lines = jsonl.split('\n')
    
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).versionId).toBe('1-abc123')
    expect(JSON.parse(lines[1]).versionId).toBe('2-def456')
  })

  test('parses JSONL to log', () => {
    const jsonl = serializeLog(sampleLog)
    const parsed = parseLog(jsonl)
    
    expect(parsed).toHaveLength(2)
    expect(parsed[0].versionId).toBe('1-abc123')
    expect(parsed[1].versionId).toBe('2-def456')
  })

  test('roundtrips correctly', () => {
    const jsonl = serializeLog(sampleLog)
    const parsed = parseLog(jsonl)
    const reserialized = serializeLog(parsed)
    
    expect(reserialized).toBe(jsonl)
  })

  test('handles empty lines in parse', () => {
    const jsonl = '{"versionId":"1"}\n\n{"versionId":"2"}\n'
    const parsed = parseLog(jsonl)
    
    expect(parsed).toHaveLength(2)
  })
})

// =============================================================================
// HOSTING PATH
// =============================================================================

describe('getHostingPath', () => {
  test('generates correct path', () => {
    const path = getHostingPath('abc123xyz')
    expect(path).toBe('/.well-known/did/abc123xyz/did.jsonl')
  })
})

// =============================================================================
// SIGNER ADAPTER
// =============================================================================

describe('signer integration', () => {
  test('creates compatible signer', async () => {
    const keyPair = await generateKeyPair('Ed25519')
    const did = `did:key:${keyPair.publicKey.slice(0, 20)}`
    const signer = createSigner(keyPair, `${did}#key-1`)
    
    // Verify our signer has the right interface
    expect(typeof signer.sign).toBe('function')
    expect(typeof signer.getVerificationMethod).toBe('function')
    expect(signer.getVerificationMethod()).toContain('#key-1')
  })
})
