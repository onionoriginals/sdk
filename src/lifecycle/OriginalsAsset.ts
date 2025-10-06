import { 
  AssetResource, 
  DIDDocument, 
  VerifiableCredential, 
  LayerType 
} from '../types';
import { validateDIDDocument, validateCredential, hashResource } from '../utils/validation';
import { CredentialManager } from '../vc/CredentialManager';
import { DIDManager } from '../did/DIDManager';
import { EventEmitter } from '../events/EventEmitter';
import type { EventHandler, EventTypeMap } from '../events/types';
import { ResourceVersionManager, ResourceHistory } from './ResourceVersioning';
import type { ResourceVersion } from './ResourceVersioning';

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

  constructor(
    resources: AssetResource[],
    did: DIDDocument,
    credentials: VerifiableCredential[]
  ) {
    this.id = did.id;
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
    for (const [resourceId, resourceVersions] of resourcesByIdMap.entries()) {
      // Sort by version number (ascending)
      const sorted = resourceVersions.sort((a, b) => {
        const versionA = a.version || 1;
        const versionB = b.version || 1;
        return versionA - versionB;
      });
      
      // Add versions in correct order to version manager
      for (const resource of sorted) {
        this.versionManager.addVersion(
          resource.id,
          resource.hash,
          resource.contentType,
          resource.previousVersionHash
        );
      }
    }
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

  async recordTransfer(from: string, to: string, transactionId: string): Promise<void> {
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
      transactionId
    });
  }

  async verify(deps?: {
    didManager?: DIDManager;
    credentialManager?: CredentialManager;
    fetch?: (url: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
  }): Promise<boolean> {
    try {
      // 1) DID Document validation (structure + supported method via validateDID)
      if (!validateDIDDocument(this.did)) {
        return false;
      }

      // 2) Resources integrity
      for (const res of this.resources) {
        if (!res || typeof res.id !== 'string' || typeof res.type !== 'string' || typeof res.contentType !== 'string') {
          return false;
        }
        if (typeof res.hash !== 'string' || !/[0-9a-f]+/i.test(res.hash)) {
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
   * @param newContent - The new content (string or Buffer)
   * @param contentType - The content type
   * @param changes - Optional description of changes
   * @returns The newly created AssetResource
   * @throws Error if content is unchanged or resource not found
   */
  addResourceVersion(
    resourceId: string,
    newContent: string | Buffer,
    contentType: string,
    changes?: string
  ): AssetResource {
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
    const contentBuffer = typeof newContent === 'string' 
      ? Buffer.from(newContent, 'utf-8')
      : newContent;
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
      content: typeof newContent === 'string' ? newContent : undefined,
      contentType,
      hash: newHash,
      size: contentBuffer.length,
      version: newVersion,
      previousVersionHash: currentResource.hash,
      createdAt: new Date().toISOString()
    };
    
    // Add to resources array (immutable - don't modify old resource)
    (this.resources as AssetResource[]).push(newResource);
    
    // Track in version manager
    this.versionManager.addVersion(
      resourceId,
      newHash,
      contentType,
      currentResource.hash,
      changes
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
      this.eventEmitter.emit(event);
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
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


