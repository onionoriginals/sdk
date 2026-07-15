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
import { ProvenanceQuery, Migration } from './ProvenanceQuery.js';
import { EventEmitter } from '../events/EventEmitter.js';
import type { EventHandler, EventTypeMap } from '../events/types.js';
import { ResourceVersionManager, ResourceHistory } from './ResourceVersioning.js';
import type { EventLog, OrdinalsLookup } from '../cel/types.js';
import { verifyEventLog } from '../cel/algorithms/verifyEventLog.js';
import { createDidManagerKeyResolver } from '../cel/keyResolver.js';
import { serializeEventLogJson, parseEventLogJson } from '../cel/serialization/json.js';
import { replayProvenance } from './replayProvenance.js';
import { checkGenesisResourceBinding } from './genesisBinding.js';
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
  resourceUpdates: Array<{
    resourceId: string;
    // Optional: foreign/legacy update events may carry no numeric version (see
    // replayProvenance — omitted rather than folded as NaN).
    fromVersion?: number;
    toVersion?: number;
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
  // via createAsset (did:cel genesis); undefined for legacy constructions.
  #celLog?: EventLog;
  // Per-layer DID documents captured at operation time (publish/inscribe/rotate).
  // These are discarded by the live flow otherwise; serialize() needs them.
  #didDocuments: Map<'did:webvh' | 'did:btco', DIDDocument> = new Map();
  // Injected by LifecycleManager (createAsset / loadAsset). Appends a signed CEL
  // event via the manager's degrade-aware path and returns the new head digest,
  // or null when the append was skipped (no keyStore / no signing key). Undefined
  // for assets constructed outside the lifecycle (they degrade in-memory only).
  #celAppender?: (type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>;
  // Per-asset serialization for addResourceVersion: the sync→async cutover made
  // the shared #celLog read-modify-write span await points, so concurrent calls
  // raced (a later _replaceCelLog clobbered an earlier signed append, or landed
  // a stale-chained unverifiable event). A promise-chain mutex forces each call
  // to run its critical section — re-read head, base-check, append — to
  // completion before the next begins.
  #appendChain: Promise<unknown> = Promise.resolve();

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

  /**
   * @internal — reconstruct an asset from a persisted envelope (loadAsset, #377).
   *
   * The public constructor FIGHTS restoration: `determineCurrentLayer` derives
   * `'did:cel'` for a published did:cel asset (the genesis layer, not the
   * current `'did:webvh'`/`'did:btco'`), and it fabricates
   * `provenance.createdAt = new Date()`. restore() constructs, then OVERWRITES
   * `currentLayer` / `bindings` / `#provenance` with values the caller folded
   * from the (already-verified) log + genesis data. It emits NO events and its
   * own logic reads NO clock — the restored state is a pure function of the log.
   */
  static restore(
    resources: AssetResource[],
    did: DIDDocument,
    credentials: VerifiableCredential[],
    log: EventLog,
    restored: {
      currentLayer: LayerType;
      bindings: Record<string, string>;
      provenance: ProvenanceChain;
    }
  ): OriginalsAsset {
    const asset = new OriginalsAsset(resources, did, credentials, log);
    asset.currentLayer = restored.currentLayer;
    asset.bindings = restored.bindings;
    asset.provenance = restored.provenance;
    return asset;
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
   * @internal — LifecycleManager binds the controller append path so
   * addResourceVersion can write signed `update` events with the same degrade
   * contract (cel:append-skipped) as the other authorship ops.
   */
  _bindCelAppender(
    fn: (type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>
  ): void {
    this.#celAppender = fn;
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
      'did:cel': ['did:webvh', 'did:btco'], // did:cel genesis
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
   * Get provenance summary
   */
  getProvenanceSummary(): {
    created: string;
    creator: string;
    currentLayer: LayerType;
    migrationCount: number;
    lastActivity: string;
  } {
    const lastMigration = this.provenance.migrations[this.provenance.migrations.length - 1];

    return {
      created: this.provenance.createdAt,
      creator: this.id,
      currentLayer: this.currentLayer,
      migrationCount: this.provenance.migrations.length,
      lastActivity: lastMigration?.timestamp || this.provenance.createdAt
    };
  }

  /**
   * Find migration by transaction ID
   */
  findByTransactionId(txId: string): Migration | null {
    return this.provenance.migrations.find(m => m.transactionId === txId) || null;
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
          ordinalsProvider: deps?.ordinalsProvider,
          // With a provider we can (and must) reject a truncated pre-rotation
          // log whose on-chain head betrays the omission (#366). No provider ⇒
          // the flag is a no-op (btco witnesses fail closed without one anyway).
          checkHeadFreshness: deps?.ordinalsProvider !== undefined
        });
        if (!celResult.verified) {
          return false;
        }

        // Bind the in-memory resources to the verified genesis: every resource
        // digest recorded at genesis must still be present among the current
        // resources. Without this, an asset holding the genuine log but swapped
        // resources passes (the log verifies, the resources don't back it).
        // Shared with loadAsset via the extracted pure helper.
        if (!checkGenesisResourceBinding(this.#celLog, this.resources)) {
          return false;
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
        // "not-a-real-hash"); this structural gate runs before the content/URL
        // integrity checks below.
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

        // Hosted (URL-only) resource: integrity is verifiable ONLY by fetching
        // and hashing. Fail closed if we can't positively confirm it (#368) —
        // a hosted resource whose bytes we can't match is not verified.
        if (typeof res.url === 'string') {
          // No fetcher → hosted content is unverifiable → fail closed.
          if (!deps?.fetch) {
            return false;
          }
          try {
            const response = await deps.fetch(res.url);
            const buf = Buffer.from(await response.arrayBuffer());
            const computed = hashResource(buf);
            const expected = (res.hash || '').toLowerCase();
            if (computed.toLowerCase() !== expected) {
              return false;
            }
          } catch {
            // Fetch error on a hosted resource → unverifiable → fail closed.
            return false;
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
   * Add a new version of a resource (immutable versioning) as a signed CEL
   * `update` event.
   *
   * Async: the new version is appended to the CEL log via the injected
   * controller appender (bound by LifecycleManager). On success the in-memory
   * resources advance and `provenance.resourceUpdates` is re-folded from the log.
   * Degraded mode (no appender bound, or the appender skips because no signing
   * key is available): the in-memory resources still advance so the object is
   * usable, but NO event is appended (the version is not provable) and a
   * `cel:append-skipped` is emitted.
   *
   * `changes` is retained for the emitted `resource:version:created` event only;
   * it is NOT part of the signed CEL body (the log is the source of truth and its
   * body is fixed — see the design contract).
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
   * @throws StructuredError('BINARY_CONTENT_UNSUPPORTED') for Buffer content (#276)
   * @throws Error if content is unchanged or the resource is not found
   */
  async addResourceVersion(
    resourceId: string,
    newContent: string,
    contentType: string,
    changes?: string
  ): Promise<AssetResource> {
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
    // Serialize the whole read-modify-write of #celLog per asset: acquire this
    // asset's append turn, run the critical section to completion, release. A
    // second queued call re-reads the head INSIDE its turn, so it chains from
    // the first call's committed result rather than a stale snapshot (Finding 2).
    const run = this.#appendChain.then(() =>
      this.#addResourceVersionCritical(resourceId, newContent, contentType, changes)
    );
    // Keep the chain alive across a rejected turn without swallowing it for the caller.
    this.#appendChain = run.catch(() => {});
    return run;
  }

  /**
   * The on-log provable head hex hash for a resourceId — the base the verifier
   * will chain the next update from: the last on-log update's derived `toHash`,
   * or (no on-log update yet) the genesis version-1 resource's `.hash`. Returns
   * undefined when there is no CEL log (nothing to prove against). Used to
   * detect an in-memory head that has diverged from the log (Finding 1).
   */
  #onLogProvableHead(resourceId: string): string | undefined {
    if (!this.#celLog) return undefined;
    const updates = replayProvenance(this.#celLog).resourceUpdates.filter(
      u => u.resourceId === resourceId
    );
    if (updates.length > 0) return updates[updates.length - 1].toHash;
    // Genesis entries are never removed, only appended — the lowest version is v1.
    const genesis = this.resources
      .filter(r => r.id === resourceId)
      .sort((a, b) => (a.version || 1) - (b.version || 1))[0];
    return genesis?.hash;
  }

  /** Critical section of addResourceVersion — runs one-at-a-time via #appendChain. */
  async #addResourceVersionCritical(
    resourceId: string,
    newContent: string,
    contentType: string,
    changes?: string
  ): Promise<AssetResource> {
    // RE-READ the current head inside the turn (a prior queued call may have
    // just committed a new version).
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

    // Append a signed `update` CEL event (or degrade). The body is the fixed
    // reference-shaped resource-update: it carries the signed toHash, not bytes.
    let appended = false;
    if (this.#celAppender) {
      // Finding 1: the verifier chains continuity from the ON-LOG head, but our
      // base is the IN-MEMORY head. They diverge once a prior update degraded
      // (in-memory advanced, log did not). Appending now would chain from a base
      // that isn't on the log → the event (and every later one) is permanently
      // unverifiable. Detect the divergence and degrade instead of poisoning.
      const onLogHead = this.#onLogProvableHead(resourceId);
      if (onLogHead !== undefined && onLogHead !== currentResource.hash) {
        await this.eventEmitter.emit({
          type: 'cel:append-skipped',
          timestamp: new Date().toISOString(),
          asset: { id: this.id },
          reason: 'UNPROVABLE_BASE'
        });
        // Do NOT also call the appender — exactly one cel:append-skipped per call.
      } else {
        // Reference-shaped body (#407 phase 1): the event carries the SIGNED
        // `toHash`, never the bytes. Content lives in the resources array /
        // serialize() envelope blobs (content-addressed store), keyed by hash.
        // This keeps the log byte-light so it can be inscribed cheaply (phase 2).
        const digest = await this.#celAppender('update', {
          resourceId,
          contentType,
          previousVersionHash: currentResource.hash,
          toHash: newHash,
          toVersion: newVersion
        });
        appended = digest !== null; // null ⇒ the manager already emitted cel:append-skipped
      }
    } else {
      // No manager bound: degrade in-memory only. Surface the honesty signal on
      // the asset emitter (the manager path uses its own emitter).
      await this.eventEmitter.emit({
        type: 'cel:append-skipped',
        timestamp: new Date().toISOString(),
        asset: { id: this.id },
        reason: this.#celLog ? 'NO_SIGNING_KEY' : 'NO_CEL_LOG'
      });
    }

    // In-memory resources advance in BOTH the appended and degraded cases.
    this.resources.push(newResource);
    this.versionManager.addVersion(
      resourceId,
      newHash,
      contentType,
      currentResource.hash,
      changes,
      newVersion
    );

    // Provenance.resourceUpdates is the source-of-truth fold of the log — only
    // populated when the event actually landed (provable). Re-fold from the log.
    if (appended && this.#celLog) {
      this.provenance.resourceUpdates = replayProvenance(this.#celLog).resourceUpdates;
    }

    const timestamp = new Date().toISOString();
    const event = {
      type: 'resource:version:created' as const,
      timestamp,
      asset: { id: this.id },
      resource: {
        id: resourceId,
        fromVersion: currentResource.version || 1,
        toVersion: newVersion,
        fromHash: currentResource.hash,
        toHash: newHash
      },
      changes
    };
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
    // did:peer was purged as a genesis layer (did:cel Phase 4 · 5/5). A did:peer
    // id can no longer be constructed, so encountering one is a caller error —
    // fail loudly rather than silently mislabel it.
    if (didId.startsWith('did:peer:')) {
      throw new Error('did:peer is no longer a supported layer; use did:cel genesis (createAsset)');
    }
    if (didId.startsWith('did:cel:')) return 'did:cel';
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


