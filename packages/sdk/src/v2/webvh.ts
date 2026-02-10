/**
 * WebVH - did:webvh layer integration
 * 
 * Wraps didwebvh-ts for creating and managing Originals on the webvh layer.
 */

import type { Original, EventLog, Signer as OriginalsSigner, Proof, DIDDocument } from './types'
import { hash } from './crypto'
import { createWebVHDID } from './did'

// =============================================================================
// TYPES
// =============================================================================

/** didwebvh-ts signer interface */
interface WebVHSigner {
  sign(input: { document: unknown; proof: unknown }): Promise<{ proofValue: string }>
  getVerificationMethodId(): string
}

/** didwebvh-ts verifier interface */
interface WebVHVerifier {
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>
}

/** didwebvh-ts DID log entry (compatible with didwebvh-ts DIDLogEntry) */
export interface DIDLogEntry {
  versionId: string
  versionTime: string
  parameters: Record<string, unknown>
  state: DIDDocument | Record<string, unknown>
  proof?: Array<{
    type: string
    cryptosuite: string
    verificationMethod: string
    created: string
    proofValue: string
    proofPurpose: string
  }>
}

/** Result from didwebvh-ts operations */
interface WebVHResult {
  did: string
  doc: Record<string, unknown>
  log: DIDLogEntry[]
  meta: {
    versionId: string
    created: string
    updated: string
    scid: string
    updateKeys: string[]
    deactivated: boolean
  }
}

export interface PublishOptions {
  /** Domain to publish to (e.g., 'originals.example') */
  domain: string
  /** Signer for the DID operations */
  signer: OriginalsSigner
  /** Update keys (multibase public keys that can update this DID) */
  updateKeys: string[]
  /** Optional path within the domain */
  path?: string
}

export interface PublishResult {
  did: string
  doc: DIDDocument
  log: DIDLogEntry[]
  scid: string
}

// =============================================================================
// ADAPTER
// =============================================================================

/**
 * Adapt our Signer to didwebvh-ts Signer interface
 */
function adaptSigner(signer: OriginalsSigner): WebVHSigner {
  return {
    async sign(input: { document: unknown; proof: unknown }): Promise<{ proofValue: string }> {
      const proof = await signer.sign(input)
      return { proofValue: proof.value }
    },
    getVerificationMethodId(): string {
      return signer.getVerificationMethod()
    },
  }
}

// =============================================================================
// PUBLISH
// =============================================================================

/**
 * Publish an Original to the webvh layer
 * 
 * This creates a did:webvh DID and returns the log that should be
 * hosted at the domain's .well-known/did/{scid}/ path.
 */
export async function publish(
  original: Original,
  options: PublishOptions
): Promise<PublishResult> {
  // Dynamic import to avoid bundling issues
  const { createDID } = await import('didwebvh-ts')

  const webvhSigner = adaptSigner(options.signer)
  
  // Build verification method from signer
  const vmId = options.signer.getVerificationMethod()
  const vmParts = vmId.split('#')
  const keyId = vmParts[1] || 'key-1'
  
  const result = await createDID({
    domain: options.domain,
    signer: webvhSigner,
    updateKeys: options.updateKeys,
    verificationMethods: [{
      id: `#${keyId}`,
      type: 'Multikey',
      publicKeyMultibase: options.updateKeys[0], // Primary key
    }],
    context: [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
  }) as WebVHResult

  return {
    did: result.did,
    doc: result.doc as unknown as DIDDocument,
    log: result.log,
    scid: result.meta.scid,
  }
}

// =============================================================================
// UPDATE
// =============================================================================

export interface UpdateWebVHOptions {
  /** Current DID log */
  log: DIDLogEntry[]
  /** Signer for the update */
  signer: OriginalsSigner
  /** New update keys (optional) */
  updateKeys?: string[]
  /** Services to add/update */
  services?: Array<{ id: string; type: string; serviceEndpoint: string }>
}

/**
 * Update a webvh DID
 */
export async function updateWebVH(
  options: UpdateWebVHOptions
): Promise<PublishResult> {
  const { updateDID } = await import('didwebvh-ts')

  const webvhSigner = adaptSigner(options.signer)

  const result = await updateDID({
    log: options.log,
    signer: webvhSigner,
    updateKeys: options.updateKeys,
    services: options.services,
  }) as WebVHResult

  return {
    did: result.did,
    doc: result.doc as unknown as DIDDocument,
    log: result.log,
    scid: result.meta.scid,
  }
}

// =============================================================================
// RESOLVE
// =============================================================================

/** Resolution result */
export interface ResolveResult {
  doc: DIDDocument | null
  meta: {
    versionId?: string
    created?: string
    updated?: string
    scid?: string
    deactivated?: boolean
    error?: string
  } | null
  error?: string
}

/**
 * Resolve a did:webvh to its document
 */
export async function resolveWebVH(did: string): Promise<ResolveResult> {
  const { resolveDID } = await import('didwebvh-ts')

  try {
    const result = await resolveDID(did)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = result.meta as any
    return {
      doc: result.doc as unknown as DIDDocument,
      meta: {
        versionId: meta?.versionId,
        created: meta?.created,
        updated: meta?.updated,
        scid: meta?.scid,
        deactivated: meta?.deactivated,
        error: meta?.error,
      },
    }
  } catch (e) {
    return {
      doc: null,
      meta: null,
      error: e instanceof Error ? e.message : 'Unknown error',
    }
  }
}

// =============================================================================
// DEACTIVATE
// =============================================================================

export interface DeactivateWebVHOptions {
  log: DIDLogEntry[]
  signer: OriginalsSigner
}

/**
 * Deactivate a webvh DID
 */
export async function deactivateWebVH(
  options: DeactivateWebVHOptions
): Promise<PublishResult> {
  const { deactivateDID } = await import('didwebvh-ts')

  const webvhSigner = adaptSigner(options.signer)

  const result = await deactivateDID({
    log: options.log,
    signer: webvhSigner,
  }) as WebVHResult

  return {
    did: result.did,
    doc: result.doc as unknown as DIDDocument,
    log: result.log,
    scid: result.meta.scid,
  }
}

// =============================================================================
// LOG HELPERS
// =============================================================================

/**
 * Serialize a webvh log for storage/hosting
 */
export function serializeLog(log: DIDLogEntry[]): string {
  // didwebvh uses JSONL format (one JSON object per line)
  return log.map(entry => JSON.stringify(entry)).join('\n')
}

/**
 * Parse a webvh log from JSONL
 */
export function parseLog(jsonl: string): DIDLogEntry[] {
  return jsonl
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as DIDLogEntry)
}

/**
 * Get the hosting path for a webvh DID
 */
export function getHostingPath(scid: string): string {
  return `/.well-known/did/${scid}/did.jsonl`
}
