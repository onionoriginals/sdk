#!/usr/bin/env bun
/**
 * Originals v2 Demo
 * 
 * Shows the complete lifecycle of an Original:
 * 1. Create on peer layer
 * 2. Update with new resources
 * 3. Add witness attestation
 * 4. Migrate to webvh
 * 5. Inscribe to Bitcoin (mock)
 * 6. Verify provenance
 */

import {
  create,
  update,
  migrate,
  verify,
  generateKeyPair,
  createSigner,
  createVerifier,
  hash,
  LocalWitness,
  addWitnessProofs,
  MockOrdinalsProvider,
  inscribeOriginal,
} from './index'
import type { Resource, Original } from './types'

// Pretty print
const log = (label: string, data: unknown) => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${label}`)
  console.log('='.repeat(60))
  console.log(JSON.stringify(data, null, 2))
}

async function main() {
  console.log('\n🎨 Originals v2 Demo\n')

  // ==========================================================================
  // SETUP
  // ==========================================================================
  
  console.log('Setting up keys...')
  const keyPair = await generateKeyPair('Ed25519')
  const did = `did:key:${keyPair.publicKey.slice(0, 20)}...`
  const verificationMethod = `${did}#key-1`
  const signer = createSigner(keyPair, verificationMethod)
  const verifier = createVerifier(keyPair.publicKey, 'Ed25519')
  
  console.log(`✓ Created Ed25519 key pair`)
  console.log(`  DID: ${did}`)

  // ==========================================================================
  // CREATE
  // ==========================================================================
  
  console.log('\n📝 Creating Original...')
  
  const artwork: Resource = {
    id: 'artwork',
    type: 'image',
    hash: hash({ content: 'my-artwork-bytes' }),
    mediaType: 'image/png',
    url: ['https://example.com/artwork.png'],
    size: 2048576, // 2MB
  }

  let original = await create({
    resources: [artwork],
    signer,
    metadata: {
      title: 'Sunset Over Mountains',
      artist: 'Demo Artist',
      year: 2024,
    },
  })

  log('Created Original', {
    did: original.did,
    layer: original.layer,
    resources: original.resources.length,
    events: original.log.events.length,
  })

  // ==========================================================================
  // UPDATE
  // ==========================================================================
  
  console.log('\n✏️  Updating Original...')
  
  const thumbnail: Resource = {
    id: 'thumbnail',
    type: 'image',
    hash: hash({ content: 'thumbnail-bytes' }),
    mediaType: 'image/jpeg',
    url: ['https://example.com/thumb.jpg'],
    size: 51200, // 50KB
  }

  original = await update({
    original,
    resources: [thumbnail],
    metadata: {
      description: 'A beautiful sunset scene with mountains',
    },
    reason: 'Added thumbnail',
    signer,
  })

  log('Updated Original', {
    did: original.did,
    resources: original.resources.map(r => r.id),
    events: original.log.events.length,
    latestEvent: original.log.events[1].type,
  })

  // ==========================================================================
  // WITNESS
  // ==========================================================================
  
  console.log('\n👁️  Adding witness attestation...')
  
  // Create a witness (in production, this would be an external service)
  const witnessKeyPair = await generateKeyPair('Ed25519')
  const witnessSigner = createSigner(witnessKeyPair, 'did:key:witness#key-1')
  const witness = new LocalWitness('did:key:witness', witnessSigner)
  
  // Get witness proof for the latest event
  const latestEvent = original.log.events[original.log.events.length - 1]
  const witnessProof = await witness.witness(latestEvent)
  
  // Add witness proof to the event
  const witnessedEvent = addWitnessProofs(latestEvent, [witnessProof])
  original = {
    ...original,
    log: {
      ...original.log,
      events: [...original.log.events.slice(0, -1), witnessedEvent],
    },
  }
  
  log('Witnessed Event', {
    eventType: witnessedEvent.type,
    proofCount: witnessedEvent.proof.length,
    witnessedAt: witnessProof.witnessedAt,
  })

  // ==========================================================================
  // VERIFY
  // ==========================================================================
  
  console.log('\n🔍 Verifying provenance...')
  
  const result = await verify({ original, verifier })
  
  log('Verification Result', result)
  
  if (result.valid) {
    console.log('✓ Original is valid!')
  } else {
    console.log('✗ Verification failed:', result.errors)
  }

  // ==========================================================================
  // MIGRATE TO WEBVH
  // ==========================================================================
  
  console.log('\n🚀 Migrating to webvh...')
  
  // Mock publish function (in real use, this would call the webvh server)
  const mockPublish = async (did: string) => {
    const scid = hash(did).slice(0, 16)
    return { did: `did:webvh:originals.example:${scid}` }
  }

  original = await migrate({
    original,
    toLayer: 'webvh',
    signer,
    publish: mockPublish,
  })

  log('Migrated Original', {
    did: original.did,
    layer: original.layer,
    events: original.log.events.length,
    latestEvent: original.log.events[2].type,
  })

  // ==========================================================================
  // INSCRIBE TO BITCOIN
  // ==========================================================================
  
  console.log('\n₿ Inscribing to Bitcoin (mock)...')
  
  const provider = new MockOrdinalsProvider()
  
  const inscription = await inscribeOriginal({
    original,
    provider,
    format: 'json',
  })

  log('Inscribed to Bitcoin', {
    did: inscription.did,
    inscriptionId: inscription.inscriptionId,
    txid: inscription.txid,
  })
  
  console.log('  → Original now has permanent Bitcoin anchor!')

  // ==========================================================================
  // FULL LOG
  // ==========================================================================
  
  console.log('\n📜 Full Event Log:')
  original.log.events.forEach((event, i) => {
    console.log(`  ${i + 1}. ${event.type.toUpperCase()}`)
    console.log(`     prev: ${event.prev ? event.prev.slice(0, 20) + '...' : '(none)'}`)
    console.log(`     proof: ${event.proof[0]?.suite || 'none'}`)
  })

  // ==========================================================================
  // DONE
  // ==========================================================================
  
  console.log('\n' + '='.repeat(60))
  console.log('  Demo Complete!')
  console.log('='.repeat(60))
  console.log(`
Summary:
  - Created Original on peer layer
  - Added thumbnail resource
  - Added witness attestation
  - Verified provenance chain
  - Migrated to webvh layer
  - Inscribed to Bitcoin

Total events in log: ${original.log.events.length}
Bitcoin inscription: ${inscription.inscriptionId}
  `)
}

main().catch(console.error)
