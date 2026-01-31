/**
 * Originals - Core Operations
 */

import type {
  Original,
  Resource,
  EventLog,
  LogEntry,
  CreateEvent,
  UpdateEvent,
  MigrateEvent,
  DeactivateEvent,
  Layer,
  Proof,
  Signer,
  Verifier,
} from './types'
import { hash, verifyProof } from './crypto'
import { createPeerDID } from './did'

// =============================================================================
// CREATE
// =============================================================================

export interface CreateOptions {
  resources: Resource[]
  signer: Signer
  metadata?: Record<string, unknown>
}

/**
 * Create a new Original on the peer layer
 */
export async function create(options: CreateOptions): Promise<Original> {
  const { resources, signer, metadata } = options
  const creatorDID = signer.getVerificationMethod().split('#')[0]
  const did = await createPeerDID(resources)
  const now = new Date().toISOString()

  const event: CreateEvent = {
    did,
    layer: 'peer',
    resources,
    creator: creatorDID,
    createdAt: now,
    metadata,
  }

  const proof = await signer.sign(event)

  const entry: LogEntry = {
    type: 'create',
    data: event,
    proof: [proof],
  }

  return {
    did,
    layer: 'peer',
    resources,
    log: { events: [entry] },
  }
}

// =============================================================================
// UPDATE
// =============================================================================

export interface UpdateOptions {
  original: Original
  resources?: Resource[]
  metadata?: Record<string, unknown>
  reason?: string
  signer: Signer
}

/**
 * Update an Original's resources or metadata
 */
export async function update(options: UpdateOptions): Promise<Original> {
  const { original, resources, metadata, reason, signer } = options

  if (original.deactivated) {
    throw new Error('Cannot update a deactivated Original')
  }

  const now = new Date().toISOString()
  const lastEntry = original.log.events[original.log.events.length - 1]
  const prevHash = hash(lastEntry)

  const event: UpdateEvent = {
    resources,
    metadata,
    updatedAt: now,
    reason,
  }

  const proof = await signer.sign(event)

  const entry: LogEntry = {
    type: 'update',
    data: event,
    prev: prevHash,
    proof: [proof],
  }

  // Merge resources
  const newResources = resources
    ? mergeResources(original.resources, resources)
    : original.resources

  return {
    ...original,
    resources: newResources,
    log: {
      ...original.log,
      events: [...original.log.events, entry],
    },
  }
}

// =============================================================================
// MIGRATE
// =============================================================================

export interface MigrateOptions {
  original: Original
  toLayer: Layer
  signer: Signer
  /** Required for btco migration */
  inscribe?: (data: unknown) => Promise<{ txid: string; did: string }>
  /** Required for webvh migration */
  publish?: (did: string, log: EventLog) => Promise<{ did: string }>
}

/**
 * Migrate an Original to a different layer
 */
export async function migrate(options: MigrateOptions): Promise<Original> {
  const { original, toLayer, signer, inscribe, publish } = options

  if (original.deactivated) {
    throw new Error('Cannot migrate a deactivated Original')
  }

  // Validate layer progression
  const layerOrder: Layer[] = ['peer', 'webvh', 'btco']
  const fromIndex = layerOrder.indexOf(original.layer)
  const toIndex = layerOrder.indexOf(toLayer)

  if (toIndex <= fromIndex) {
    throw new Error(`Cannot migrate from ${original.layer} to ${toLayer}`)
  }

  const now = new Date().toISOString()
  const lastEntry = original.log.events[original.log.events.length - 1]
  const prevHash = hash(lastEntry)

  let newDid: string
  let txid: string | undefined

  if (toLayer === 'webvh') {
    if (!publish) throw new Error('publish function required for webvh migration')
    const result = await publish(original.did, original.log)
    newDid = result.did
  } else if (toLayer === 'btco') {
    if (!inscribe) throw new Error('inscribe function required for btco migration')
    const result = await inscribe(original)
    newDid = result.did
    txid = result.txid
  } else {
    throw new Error(`Unknown layer: ${toLayer}`)
  }

  const event: MigrateEvent = {
    fromLayer: original.layer,
    toLayer,
    newDid,
    migratedAt: now,
    txid,
  }

  const proof = await signer.sign(event)

  const entry: LogEntry = {
    type: 'migrate',
    data: event,
    prev: prevHash,
    proof: [proof],
  }

  return {
    ...original,
    did: newDid,
    layer: toLayer,
    log: {
      ...original.log,
      events: [...original.log.events, entry],
    },
  }
}

// =============================================================================
// DEACTIVATE
// =============================================================================

export interface DeactivateOptions {
  original: Original
  reason?: string
  signer: Signer
}

/**
 * Deactivate an Original (soft delete)
 */
export async function deactivate(options: DeactivateOptions): Promise<Original> {
  const { original, reason, signer } = options

  if (original.deactivated) {
    throw new Error('Original is already deactivated')
  }

  const now = new Date().toISOString()
  const lastEntry = original.log.events[original.log.events.length - 1]
  const prevHash = hash(lastEntry)

  const event: DeactivateEvent = {
    deactivatedAt: now,
    reason,
  }

  const proof = await signer.sign(event)

  const entry: LogEntry = {
    type: 'deactivate',
    data: event,
    prev: prevHash,
    proof: [proof],
  }

  return {
    ...original,
    deactivated: true,
    log: {
      ...original.log,
      events: [...original.log.events, entry],
    },
  }
}

// =============================================================================
// VERIFY
// =============================================================================

export interface VerifyOptions {
  original: Original
  verifier?: Verifier
}

export interface VerifyResult {
  valid: boolean
  errors: string[]
}

/**
 * Verify an Original's provenance chain
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const { original, verifier } = options
  const errors: string[] = []

  const events = original.log.events

  for (let i = 0; i < events.length; i++) {
    const entry = events[i]

    // Check hash chain
    if (i === 0) {
      if (entry.prev) {
        errors.push(`First event should not have prev hash`)
      }
    } else {
      const expectedPrev = hash(events[i - 1])
      if (entry.prev !== expectedPrev) {
        errors.push(`Event ${i}: hash chain broken`)
      }
    }

    // Verify proofs
    if (entry.proof.length === 0) {
      errors.push(`Event ${i}: no proof`)
    }

    if (verifier) {
      for (const proof of entry.proof) {
        const valid = await verifier.verify(proof, entry.data)
        if (!valid) {
          errors.push(`Event ${i}: invalid proof`)
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function mergeResources(existing: Resource[], updates: Resource[]): Resource[] {
  const byId = new Map(existing.map(r => [r.id, r]))
  for (const r of updates) {
    byId.set(r.id, r)
  }
  return Array.from(byId.values())
}
