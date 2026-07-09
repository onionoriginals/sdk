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
     * When true, every resource must have its content cryptographically verified
     * against its declared hash. A resource that cannot be content-verified —
     * URL-only with no `fetch` supplied, or a resource with neither inline
     * `content` nor a fetchable `url` — causes verification to fail closed.
     * Defaults to false, which preserves offline/structural verification
     * (e.g. did:peer assets whose content is transported out of band).
     * Note: independent of this flag, if a `fetch` IS supplied it is treated as
     * an opt-in to content verification, so a fetch failure or hash mismatch on
     * any resource always fails verification.
     */
    requireContentVerification?: boolean;
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
    requireContentVerification?: boolean;
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

        // URL-only resource: verify hosted bytes against the declared hash.
        if (typeof res.url === 'string') {
          if (deps?.fetch) {
            // Supplying a fetch is an opt-in to content verification: a fetch
            // failure or a hash mismatch means the content could not be
            // confirmed, so fail closed rather than silently passing (#368).
            let buf: Buffer;
            try {
              const response = await deps.fetch(res.url);
              buf = Buffer.from(await response.arrayBuffer());
            } catch {
              return false;
            }
            const computed = hashResource(buf);
            const expected = (res.hash || '').toLowerCase();
            if (computed.toLowerCase() !== expected) {
              return false;
            }
            continue;
          }
          // No fetch provided: content cannot be verified here. By default we
          // fall back to structural validation (offline verification). When the
          // caller requires content verification, this is a failure.
          if (deps?.requireContentVerification) {
            return false;
          }
          continue;
        }

        // Resource has neither inline content nor a URL: its content can never
        // be checked against the hash. Only a hard requirement rejects it.
        if (deps?.requireContentVerification) {
          return false;
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
   * Reconstruct and cryptographically verify the asset's provenance chain from
   * its credentials.
   *
   * Unlike {@link verify}, which validates each credential in isolation, this
   * walks the `credentialSubject.previousCredential` links to establish an
   * ordering, then delegates to {@link CredentialManager.verifyCredentialChain}
   * to check (a) that every credential verifies against its issuer's key and
   * (b) that each `previousCredential` id/hash link resolves to the preceding
   * credential. This closes the gap where provenance existed only as in-memory
   * session state that `verify()` never checked (#367).
   *
   * The returned `chainLinked` flag reports whether the credentials actually
   * form a linked chain: credentials issued without chaining metadata (the
   * current production default) verify individually but are reported as
   * unlinked, so callers can distinguish "cryptographically chained history"
   * from "a bag of independently-valid credentials."
   */
  async verifyProvenance(deps: {
    credentialManager: CredentialManager;
  }): Promise<{
    valid: boolean;
    errors: string[];
    verifiedCredentials: number;
    chainLength: number;
    chainLinked: boolean;
  }> {
    const { credentialManager } = deps;
    const credentials = this.credentials;

    if (credentials.length === 0) {
      return { valid: true, errors: [], verifiedCredentials: 0, chainLength: 0, chainLinked: false };
    }

    // Structural validation first — a malformed credential should not reach the
    // cryptographic chain check.
    for (const cred of credentials) {
      if (!validateCredential(cred)) {
        return {
          valid: false,
          errors: ['One or more credentials failed structural validation'],
          verifiedCredentials: 0,
          chainLength: credentials.length,
          chainLinked: false
        };
      }
    }

    const { ordered, linked, errors: orderErrors } = OriginalsAsset.orderCredentialChain(credentials);

    const chainResult = await credentialManager.verifyCredentialChain(ordered);

    const errors = [...orderErrors, ...chainResult.errors];
    const verifiedCredentials = credentials.length - chainResult.errors
      .filter(e => e.startsWith('Credential at index')).length;

    return {
      valid: errors.length === 0,
      errors,
      verifiedCredentials,
      chainLength: chainResult.chainLength,
      chainLinked: linked
    };
  }

  /**
   * Order a set of credentials into chain sequence (oldest → newest) by
   * following `credentialSubject.previousCredential.id` links. Returns the
   * credentials unchanged (and `linked: false`) when no chaining metadata is
   * present, and surfaces structural chain problems (multiple roots, cycles,
   * dangling links) as errors rather than throwing.
   */
  private static orderCredentialChain(credentials: VerifiableCredential[]): {
    ordered: VerifiableCredential[];
    linked: boolean;
    errors: string[];
  } {
    interface SubjectWithPrevious {
      previousCredential?: { id?: string; hash?: string };
    }
    const prevIdOf = (c: VerifiableCredential): string | undefined =>
      (c.credentialSubject as (typeof c.credentialSubject) & SubjectWithPrevious)?.previousCredential?.id;

    const anyLinks = credentials.some(c => prevIdOf(c) !== undefined);
    if (!anyLinks) {
      return { ordered: credentials, linked: false, errors: [] };
    }

    const errors: string[] = [];
    const byId = new Map<string, VerifiableCredential>();
    for (const c of credentials) {
      if (typeof c.id === 'string') byId.set(c.id, c);
    }

    // Roots: credentials with no previousCredential link (or a dangling one).
    const roots = credentials.filter(c => {
      const p = prevIdOf(c);
      return p === undefined || !byId.has(p);
    });
    if (roots.length !== 1) {
      errors.push(`Provenance chain does not have a single root (found ${roots.length})`);
      return { ordered: credentials, linked: true, errors };
    }

    // Follow forward links: next is the credential whose previous points at current.
    const nextOf = new Map<string, VerifiableCredential>();
    for (const c of credentials) {
      const p = prevIdOf(c);
      if (p !== undefined && byId.has(p)) {
        if (nextOf.has(p)) {
          errors.push(`Provenance chain forks at credential ${p}`);
          return { ordered: credentials, linked: true, errors };
        }
        nextOf.set(p, c);
      }
    }

    const ordered: VerifiableCredential[] = [];
    const seen = new Set<string>();
    let cursor: VerifiableCredential | undefined = roots[0];
    while (cursor) {
      if (typeof cursor.id === 'string') {
        if (seen.has(cursor.id)) {
          errors.push('Provenance chain contains a cycle');
          return { ordered: credentials, linked: true, errors };
        }
        seen.add(cursor.id);
      }
      ordered.push(cursor);
      cursor = typeof cursor.id === 'string' ? nextOf.get(cursor.id) : undefined;
    }

    if (ordered.length !== credentials.length) {
      errors.push('Provenance chain is disconnected (not all credentials are reachable from the root)');
    }

    return { ordered, linked: true, errors };
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
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


