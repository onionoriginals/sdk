import { 
  AssetResource, 
  DIDDocument, 
  VerifiableCredential, 
  LayerType 
} from '../types/index.js';
import { validateDIDDocument, validateCredential, hashResource } from '../utils/validation.js';
import { StructuredError } from '../utils/telemetry.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { DIDManager } from '../did/DIDManager.js';
import { ProvenanceQuery, Migration, Transfer } from './ProvenanceQuery.js';
import { EventEmitter } from '../events/EventEmitter.js';
import type { EventHandler, EventTypeMap } from '../events/types.js';
import { ResourceVersionManager, ResourceHistory } from './ResourceVersioning.js';
import type { EventLog, OrdinalsLookup } from '../cel/types.js';
import { verifyEventLog } from '../cel/algorithms/verifyEventLog.js';
import { createDidManagerKeyResolver } from '../cel/keyResolver.js';
import { hexSha256ToDigestMultibase } from '../cel/signerAdapter.js';
import { serializeEventLogJson, parseEventLogJson } from '../cel/serialization/json.js';
import { replayProvenance } from './replayProvenance.js';
import {
  ASSET_ENVELOPE_FORMAT,
  ASSET_ENVELOPE_VERSION,
  type AssetEnvelope
} from './assetEnvelope.js';

export interface ProvenanceChain {
  createdAt: string;
  creator: string;
  txid?: string;
  migrations: Array<{
    from: LayerType;
    to: LayerType;
    timestamp: string;
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    commitTxId?: string;
    revealTxId?: string;
    feeRate?: number;
  }>;
  transfers: Array<{
    from: string;
    to: string;
    timestamp: string;
    transactionId: string;
  }>;
  resourceUpdates: Array<{
    resourceId: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
    timestamp: string;
    changes?: string;
  }>;
}

export class OriginalsAsset {
  public readonly id: string;
  public readonly resources: AssetResource[];
  public readonly did: DIDDocument;
  public readonly credentials: VerifiableCredential[];
  public currentLayer: LayerType;
  public bindings?: Record<string, string>;
  private provenance: ProvenanceChain;
  private eventEmitter: EventEmitter;
  private versionManager: ResourceVersionManager;
  // The CEL event log backing this asset's provenance. Present for assets minted
  // via createAsset (did:cel genesis); undefined for legacy did:peer constructions.
  #celLog?: EventLog;
  // Per-layer DID documents captured at operation time (publish/inscribe/rotate).
  // These are discarded by the live flow otherwise; serialize() needs them.
  #didDocuments: Map<'did:webvh' | 'did:btco', DIDDocument> = new Map();

  constructor(
    resources: AssetResource[],
    did: DIDDocument,
    credentials: VerifiableCredential[],
    eventLog?: EventLog
  ) {
    this.id = did.id;
    this.#celLog = eventLog;
    this.resources = resources;
    this.did = did;
    this.credentials = credentials;
    this.currentLayer = this.determineCurrentLayer(did.id);
    this.provenance = {
      createdAt: new Date().toISOString(),
      creator: did.id,
      migrations: [],
      transfers: [],
      resourceUpdates: []
    };
    this.eventEmitter = new EventEmitter();
    this.versionManager = new ResourceVersionManager();
    
    // Initialize version manager with existing resources
    // Group resources by ID and sort each group by version to handle unsorted persisted data
    const resourcesByIdMap = new Map<string, AssetResource[]>();
    for (const resource of resources) {
      const existing = resourcesByIdMap.get(resource.id) || [];
      existing.push(resource);
      resourcesByIdMap.set(resource.id, existing);
    }
    
    // Process each resource ID's versions in sorted order
    for (const resourceVersions of resourcesByIdMap.values()) {
      // Sort by version number (ascending)
      const sorted = resourceVersions.sort((a, b) => {
        const versionA = a.version || 1;
        const versionB = b.version || 1;
        return versionA - versionB;
      });
      
      // Add versions in correct order to version manager, preserving each
      // resource's own declared version number (so gapped/duplicate sets are
      // not silently renumbered 1..N).
      for (const resource of sorted) {
        this.versionManager.addVersion(
          resource.id,
          resource.hash,
          resource.contentType,
          resource.previousVersionHash,
          undefined,
          resource.version
        );
      }
    }
  }

  /** The CEL event log backing this asset, if minted via createAsset. */
  get celLog(): EventLog | undefined {
    return this.#celLog;
  }

  /**
   * @internal — LifecycleManager owns appends. Swaps the attached CEL log
   * (e.g. after appending a migrate/transfer event).
   */
  _replaceCelLog(log: EventLog): void {
    this.#celLog = log;
  }

  /**
   * @internal — LifecycleManager captures the per-layer DID document built at
   * operation time (publishToWeb, inscribeOnBitcoin, rotateBtcoKeys), which the
   * live flow otherwise discards. serialize() emits them under `didDocuments`.
   * A later capture for the SAME layer replaces the earlier one (e.g. a rotate
   * replaces the inscription-time btco doc).
   */
  _captureDidDocument(layer: 'did:webvh' | 'did:btco', doc: DIDDocument): void {
    // Clone at capture time: the caller may keep and later mutate `doc` (it
    // built it locally moments before), which must not corrupt this cache.
    this.#didDocuments.set(layer, structuredClone(doc));
  }

  /**
   * Serialize this asset into a versioned, JSON-safe {@link AssetEnvelope} (#377).
   *
   * Sync and pure: the envelope's provenance IS the CEL (`eventLog`); everything
   * the log cannot derive (commitTxId, feeRate, post-genesis resource updates, a
   * btco binding not yet anchored by a witness proof) rides in the `unverified`
   * honesty section — advisory only, never trusted at load/verify time.
   *
   * @throws StructuredError('ASSET_NOT_SERIALIZABLE') for legacy assets that have
   *   no CEL log (constructed without an eventLog) — there is no provenance to
   *   encode.
   */
  serialize(): AssetEnvelope {
    if (!this.#celLog) {
      throw new StructuredError(
        'ASSET_NOT_SERIALIZABLE',
        'Asset has no CEL event log to serialize. Only assets minted via ' +
        'createAsset (did:cel genesis) carry the provenance an envelope encodes.'
      );
    }

    // Round-trip through the JSON serialization gate: validates the log and
    // yields a clean, JSON-safe parsed object (preserving witness-proof
    // extension fields) decoupled from the live #celLog reference.
    const eventLog = parseEventLogJson(serializeEventLogJson(this.#celLog));

    // Clone every doc handed out: these are LIVE readonly state (`this.did`)
    // or the per-layer capture cache — a caller mutating the returned envelope
    // must never be able to corrupt the signing-key material asset.migrate
    // and inscribeOnBitcoin consume.
    const didDocuments: AssetEnvelope['didDocuments'] = { 'did:cel': structuredClone(this.did) };
    const webvhDoc = this.#didDocuments.get('did:webvh');
    if (webvhDoc) didDocuments['did:webvh'] = structuredClone(webvhDoc);
    const btcoDoc = this.#didDocuments.get('did:btco');
    if (btcoDoc) didDocuments['did:btco'] = structuredClone(btcoDoc);

    // Honesty section — assembled from the live in-memory caches only.
    const unverified: NonNullable<AssetEnvelope['unverified']> = {};
    // commitTxId / feeRate live only on the ProvenanceChain (never in the log).
    // The btco migration is the sole carrier of both.
    const btcoMigration = this.provenance.migrations.find(m => m.to === 'did:btco');
    if (btcoMigration?.commitTxId) unverified.commitTxId = btcoMigration.commitTxId;
    if (typeof btcoMigration?.feeRate === 'number') unverified.feeRate = btcoMigration.feeRate;
    if (this.provenance.resourceUpdates.length > 0) {
      unverified.resourceUpdates = this.provenance.resourceUpdates.map(u => ({ ...u }));
    }
    // Degraded binding: the fold can't derive did:btco (no witness proof in the
    // log) but the live cache holds it — surface the whole live binding snapshot
    // as advisory. Do NOT promote it: loadAsset must not trust it.
    const foldedBtco = replayProvenance(this.#celLog).bindings['did:btco'];
    const liveBtco = this.bindings?.['did:btco'];
    if (!foldedBtco && liveBtco) {
      unverified.bindings = { ...this.bindings };
    }

    const envelope: AssetEnvelope = {
      format: ASSET_ENVELOPE_FORMAT,
      version: ASSET_ENVELOPE_VERSION,
      assetDid: this.id,
      eventLog,
      didDocuments,
      resources: this.resources.map(r => ({ ...r }))
    };
    if (this.credentials.length > 0) {
      envelope.credentials = this.credentials.map(c => ({ ...c }));
    }
    if (Object.keys(unverified).length > 0) {
      envelope.unverified = unverified;
    }
    return envelope;
  }

  async migrate(
    toLayer: LayerType,
    details?: {
      transactionId?: string;
      inscriptionId?: string;
      satoshi?: string;
      commitTxId?: string;
      revealTxId?: string;
      feeRate?: number;
    }
  ): Promise<void> {
    // Handle migration between layers
    const validTransitions: Record<LayerType, LayerType[]> = {
      'did:peer': ['did:webvh', 'did:btco'],
      'did:webvh': ['did:btco'],
      'did:btco': [] // No further migrations possible
    };

    if (!validTransitions[this.currentLayer].includes(toLayer)) {
      throw new Error(`Invalid migration from ${this.currentLayer} to ${toLayer}`);
    }
    
    const fromLayer = this.currentLayer;
    
    this.provenance.migrations.push({
      from: fromLayer,
      to: toLayer,
      timestamp: new Date().toISOString(),
      transactionId: details?.transactionId,
      inscriptionId: details?.inscriptionId,
      satoshi: details?.satoshi,
      commitTxId: details?.commitTxId,
      revealTxId: details?.revealTxId,
      feeRate: details?.feeRate
    });
    if (details?.transactionId) {
      this.provenance.txid = details.transactionId;
    }
    this.currentLayer = toLayer;
    
    // Emit migration event and await handlers
    await this.eventEmitter.emit({
      type: 'asset:migrated',
      timestamp: new Date().toISOString(),
      asset: {
        id: this.id,
        fromLayer,
        toLayer
      },
      details
    });
  }

  getProvenance(): ProvenanceChain {
    return this.provenance;
  }

  async recordTransfer(from: string, to: string, transactionId: string, keyRotationPending?: boolean): Promise<void> {
    this.provenance.transfers.push({
      from,
      to,
      timestamp: new Date().toISOString(),
      transactionId
    });
    this.provenance.txid = transactionId;

    // Emit transfer event and await handlers
    await this.eventEmitter.emit({
      type: 'asset:transferred',
      timestamp: new Date().toISOString(),
      asset: {
        id: this.id,
        layer: this.currentLayer
      },
      from,
      to,
      transactionId,
      // Keep in sync with the manager's mirror emit (LifecycleManager#366) so
      // asset.on(...) subscribers see the same flag as sdk.lifecycle.on(...).
      ...(keyRotationPending !== undefined ? { keyRotationPending } : {})
    });
  }

  /**
   * Query provenance with fluent API
   */
  queryProvenance(): ProvenanceQuery {
    return new ProvenanceQuery(this.provenance);
  }

  /**
   * Get all migrations to a specific layer
   */
  getMigrationsToLayer(layer: LayerType): Migration[] {
    return this.provenance.migrations.filter(m => m.to === layer);
  }

  /**
   * Get all transfers from an address
   */
  getTransfersFrom(address: string): Transfer[] {
    return this.provenance.transfers.filter(t => t.from === address);
  }

  /**
   * Get all transfers to an address
   */
  getTransfersTo(address: string): Transfer[] {
    return this.provenance.transfers.filter(t => t.to === address);
  }

  /**
   * Get provenance summary
   */
  getProvenanceSummary(): {
    created: string;
    creator: string;
    currentLayer: LayerType;
    migrationCount: number;
    transferCount: number;
    lastActivity: string;
  } {
    const lastMigration = this.provenance.migrations[this.provenance.migrations.length - 1];
    const lastTransfer = this.provenance.transfers[this.provenance.transfers.length - 1];
    
    return {
      created: this.provenance.createdAt,
      creator: this.id,
      currentLayer: this.currentLayer,
      migrationCount: this.provenance.migrations.length,
      transferCount: this.provenance.transfers.length,
      lastActivity: lastTransfer?.timestamp || lastMigration?.timestamp || this.provenance.createdAt
    };
  }

  /**
   * Find migration or transfer by transaction ID
   */
  findByTransactionId(txId: string): Migration | Transfer | null {
    const migration = this.provenance.migrations.find(m => m.transactionId === txId);
    if (migration) return migration;
    
    const transfer = this.provenance.transfers.find(t => t.transactionId === txId);
    return transfer || null;
  }

  /**
   * Find migration by inscription ID
   */
  findByInscriptionId(inscriptionId: string): Migration | null {
    return this.provenance.migrations.find(m => m.inscriptionId === inscriptionId) || null;
  }

  async verify(deps?: {
    didManager?: DIDManager;
    credentialManager?: CredentialManager;
    fetch?: (url: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
    /**
     * Required to verify `bitcoin-ordinals-2024` witness proofs in the CEL log
     * (btco-anchored assets). Without it, a log carrying a bitcoin witness
     * proof fails closed — see VerifyOptions.ordinalsProvider.
     */
    ordinalsProvider?: OrdinalsLookup;
  }): Promise<boolean> {
    const result = await this.runVerificationChecks(deps);
    // 'verification:completed' is part of the public EventTypeMap and is
    // subscribed by EventLogger; it was declared but never emitted (issue #352).
    await this.eventEmitter.emit({
      type: 'verification:completed',
      timestamp: new Date().toISOString(),
      asset: { id: this.id },
      result
    });
    return result;
  }

  private async runVerificationChecks(deps?: {
    didManager?: DIDManager;
    credentialManager?: CredentialManager;
    fetch?: (url: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
    ordinalsProvider?: OrdinalsLookup;
  }): Promise<boolean> {
    try {
      // 0) GATING: whole-chain CEL verification. `expectedDid: this.id` is the
      // binding check for _replaceCelLog — a swapped-in foreign log (even one
      // valid on its own terms) does not back this asset's DID and fails here.
      // Assets without a celLog (legacy constructions) skip this entirely.
      if (this.#celLog) {
        const celResult = await verifyEventLog(this.#celLog, {
          expectedDid: this.id,
          resolveKey: deps?.didManager ? createDidManagerKeyResolver(deps.didManager) : undefined,
          ordinalsProvider: deps?.ordinalsProvider
        });
        if (!celResult.verified) {
          return false;
        }

        // Bind the in-memory resources to the verified genesis: every resource
        // digest recorded at genesis must still be present among the current
        // resources. Without this, an asset holding the genuine log but swapped
        // resources passes (the log verifies, the resources don't back it).
        // Direction is subset (genesis ⊆ current): addResourceVersion may add
        // MORE, but a genesis entry may never go MISSING.
        const genesis = this.#celLog.events[0]?.data as
          { resources?: unknown; did?: unknown } | undefined;
        const genesisResources = genesis?.resources;
        if (!Array.isArray(genesisResources)) {
          // Controller-shaped genesis MUST carry a resources array; a missing/
          // malformed one fails closed. Only legacy-shaped geneses (data.did) —
          // which predate this contract — skip the check.
          if (typeof genesis?.did !== 'string') {
            return false;
          }
        } else {
          const present = new Set(this.resources.map(r => hexSha256ToDigestMultibase(r.hash)));
          for (const entry of genesisResources) {
            const dm = (entry as { digestMultibase?: unknown })?.digestMultibase;
            if (typeof dm !== 'string' || !present.has(dm)) {
              return false;
            }
          }
        }
      }

      // 1) DID Document validation (structure + supported method via validateDID)
      if (!validateDIDDocument(this.did)) {
        return false;
      }

      // 2) Resources integrity
      for (const res of this.resources) {
        if (!res || typeof res.id !== 'string' || typeof res.type !== 'string' || typeof res.contentType !== 'string') {
          return false;
        }
        // Anchored: the hash must be entirely hex. An unanchored test would
        // accept any string merely containing a hex character (e.g.
        // "not-a-real-hash"), which for URL-only resources with no fetch
        // provided is the only integrity check performed.
        if (typeof res.hash !== 'string' || !/^[0-9a-f]+$/i.test(res.hash)) {
          return false;
        }

        // If inline content is present, verify by hashing it
        if (typeof res.content === 'string') {
          const data = Buffer.from(res.content, 'utf8');
          const computed = hashResource(data);
          const expected = (res.hash || '').toLowerCase();
          if (computed.toLowerCase() !== expected) {
            return false;
          }
          continue;
        }

        // If URL present and fetch is provided, attempt to fetch and hash
        if (typeof res.url === 'string' && deps?.fetch) {
          try {
            const response = await deps.fetch(res.url);
            const buf = Buffer.from(await response.arrayBuffer());
            const computed = hashResource(buf);
            const expected = (res.hash || '').toLowerCase();
            if (computed.toLowerCase() !== expected) {
              return false;
            }
          } catch {
            // On fetch error, treat as unverifiable but do not fail the entire asset
            // Fall back to structural validation only
          }
        }
      }

      // 3) Credentials validation
      for (const cred of this.credentials) {
        if (!validateCredential(cred)) {
          return false;
        }
      }

      // If a credentialManager with didManager is provided, verify each credential cryptographically
      if (deps?.credentialManager && deps.credentialManager instanceof CredentialManager && deps?.didManager) {
        for (const cred of this.credentials) {
          const ok = await deps.credentialManager.verifyCredential(cred);
          if (!ok) return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to an event
   * 
   * @param eventType - The type of event to listen for
   * @param handler - The handler function to call when the event is emitted
   * @returns A function to unsubscribe the handler
   */
  on<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    return this.eventEmitter.on(eventType, handler);
  }

  /**
   * Subscribe to an event for a single emission
   * 
   * @param eventType - The type of event to listen for
   * @param handler - The handler function to call when the event is emitted (only once)
   * @returns A function to unsubscribe the handler
   */
  once<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    return this.eventEmitter.once(eventType, handler);
  }

  /**
   * Unsubscribe from an event
   * 
   * @param eventType - The type of event to stop listening for
   * @param handler - The handler function to remove
   */
  off<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): void {
    this.eventEmitter.off(eventType, handler);
  }

  /**
   * Internal method for LifecycleManager to emit events
   * This allows type-safe event emission without exposing the internal EventEmitter
   * 
   * @internal
   * @param event - The event to emit
   */
  _internalEmit<K extends keyof EventTypeMap>(event: EventTypeMap[K]): Promise<void> {
    return this.eventEmitter.emit(event);
  }

  /**
   * Add a new version of a resource (immutable versioning).
   * Creates a new AssetResource with incremented version number and links it to the previous version.
   * 
   * @param resourceId - The logical resource ID
   * @param newContent - The new content. Must be a string: AssetResource can
   *   only carry inline string content, so Buffer input is rejected rather
   *   than silently reduced to a hash-only version (issue #276). For binary
   *   resources, pass the content as a string in a text-safe encoding you
   *   control, or manage the bytes externally and reference them by hash.
   * @param contentType - The content type
   * @param changes - Optional description of changes
   * @returns The newly created AssetResource
   * @throws Error if content is unchanged, resource not found, or newContent is a Buffer
   */
  addResourceVersion(
    resourceId: string,
    newContent: string,
    contentType: string,
    changes?: string
  ): AssetResource {
    // AssetResource.content is a string; a Buffer used to be silently dropped
    // (only its hash was stored), unrecoverably losing the binary content
    // while the caller believed it was versioned (issue #276). The parameter
    // is now declared `string` so TypeScript callers get a compile-time error
    // (issue #311); the runtime guard stays for JS callers.
    if (typeof newContent !== 'string') {
      throw new StructuredError(
        'BINARY_CONTENT_UNSUPPORTED',
        'addResourceVersion cannot store binary (Buffer) content inline: AssetResource.content is a string. ' +
        'Encode the content as a string (e.g. base64) and handle decoding at publish time, ' +
        'or host the bytes externally and reference them by hash.'
      );
    }
    // Find the current version of the resource by id
    const currentResources = this.resources.filter(r => r.id === resourceId);
    if (currentResources.length === 0) {
      throw new Error(`Resource with id ${resourceId} not found`);
    }
    
    // Get the latest version
    const currentResource = currentResources.sort((a, b) => {
      const versionA = a.version || 1;
      const versionB = b.version || 1;
      return versionB - versionA;
    })[0];
    
    // Compute new hash
    const contentBuffer = Buffer.from(newContent, 'utf-8');
    const newHash = hashResource(contentBuffer);
    
    // Check if content has actually changed
    if (newHash === currentResource.hash) {
      throw new Error('Content unchanged - new version would be identical to current version');
    }
    
    // Create new resource version
    const newVersion = (currentResource.version || 1) + 1;
    const newResource: AssetResource = {
      id: resourceId,
      type: currentResource.type,
      content: newContent,
      contentType,
      hash: newHash,
      size: contentBuffer.length,
      version: newVersion,
      previousVersionHash: currentResource.hash,
      createdAt: new Date().toISOString()
    };
    
    // Add to resources array (immutable - don't modify old resource)
    this.resources.push(newResource);
    
    // Track in version manager, using the resource's own next version number so
    // the manager numbering matches getResourceVersion(id, newVersion).
    this.versionManager.addVersion(
      resourceId,
      newHash,
      contentType,
      currentResource.hash,
      changes,
      newVersion
    );
    
    // Update provenance
    const timestamp = new Date().toISOString();
    this.provenance.resourceUpdates.push({
      resourceId,
      fromVersion: currentResource.version || 1,
      toVersion: newVersion,
      fromHash: currentResource.hash,
      toHash: newHash,
      timestamp,
      changes
    });
    
    // Emit version-created event
    const event = {
      type: 'resource:version:created' as const,
      timestamp,
      asset: {
        id: this.id
      },
      resource: {
        id: resourceId,
        fromVersion: currentResource.version || 1,
        toVersion: newVersion,
        fromHash: currentResource.hash,
        toHash: newHash
      },
      changes
    };
    
    // Emit asynchronously (don't block)
    queueMicrotask(() => {
      void this.eventEmitter.emit(event);
    });
    
    return newResource;
  }

  /**
   * Get a specific version of a resource
   * @param resourceId - The logical resource ID
   * @param version - The version number (1-indexed)
   * @returns The AssetResource for that version, or null if not found
   */
  getResourceVersion(resourceId: string, version: number): AssetResource | null {
    const resource = this.resources.find(r => 
      r.id === resourceId && (r.version || 1) === version
    );
    return resource || null;
  }

  /**
   * Get all versions of a resource
   * @param resourceId - The logical resource ID
   * @returns Array of all AssetResource versions, sorted by version number
   */
  getAllVersions(resourceId: string): AssetResource[] {
    return this.resources
      .filter(r => r.id === resourceId)
      .sort((a, b) => (a.version || 1) - (b.version || 1));
  }

  /**
   * Get the version history for a resource
   * @param resourceId - The logical resource ID
   * @returns ResourceHistory or null if resource not found
   */
  getResourceHistory(resourceId: string): ResourceHistory | null {
    return this.versionManager.getHistory(resourceId);
  }

  private determineCurrentLayer(didId: string): LayerType {
    if (didId.startsWith('did:peer:')) return 'did:peer';
    // did:cel is the genesis-layer synonym for did:peer (Phase-4 may introduce a dedicated layer).
    if (didId.startsWith('did:cel:')) return 'did:peer';
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


