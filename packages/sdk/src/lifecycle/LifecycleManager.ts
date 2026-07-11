import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
  KeyStore,
  ExternalSigner,
  VerifiableCredential,
  LayerType,
  DIDDocument
} from '../types/index.js';
import { BitcoinManager, MAX_REASONABLE_FEE_RATE } from '../bitcoin/BitcoinManager.js';
import { DIDManager } from '../did/DIDManager.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { OriginalsAsset, type ProvenanceChain } from './OriginalsAsset.js';
import { replayProvenance } from './replayProvenance.js';
import { checkGenesisResourceBinding } from './genesisBinding.js';
import {
  ASSET_ENVELOPE_FORMAT,
  ASSET_ENVELOPE_VERSION,
  type AssetEnvelope
} from './assetEnvelope.js';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding.js';
import { hashResource } from '../utils/validation.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { parseSatoshiIdentifier } from '../utils/satoshi-validation.js';
import { btcoDidPrefix } from '../cel/btcoDid.js';
import { KeyManager } from '../did/KeyManager.js';
import { celSignerFromKeyPair, hexSha256ToDigestMultibase, createKeyStoreCelSigner, currentControllerVm } from '../cel/signerAdapter.js';
import { createCelDidDocument, didCelMatchesLog, deriveDidCel, DID_CEL_PREFIX } from '../cel/celDid.js';
import { verifyEventLog } from '../cel/algorithms/verifyEventLog.js';
import { createDidManagerKeyResolver } from '../cel/keyResolver.js';
import { PeerCelManager } from '../cel/layers/PeerCelManager.js';
import { appendEvent } from '../cel/algorithms/appendEvent.js';
import { computeDigestMultibase } from '../cel/hash.js';
import { canonicalizeEntryForChain } from '../cel/canonicalize.js';
import { serializeEventLogJson, parseEventLogJson } from '../cel/serialization/json.js';
import type { EventLog, LogEntry, ExternalReference, WitnessProof, OrdinalsLookup, VerificationResult } from '../cel/types.js';
import { getBitcoinNetworkForWebVH } from '../types/network.js';
import { multikey } from '../crypto/Multikey.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createBtcoDidDocument } from '../did/createBtcoDidDocument.js';
import { EventEmitter } from '../events/EventEmitter.js';
import type { EventHandler, EventTypeMap } from '../events/types.js';
import { Logger } from '../utils/Logger.js';
import { StructuredError } from '../utils/telemetry.js';
import { MetricsCollector } from '../utils/MetricsCollector.js';
import {
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
} from './BatchOperations.js';
import { BatchLifecycleOperations } from './BatchLifecycleOperations.js';
import { validateAndNormalizeDomain, tryValidateDomain, safeDecodeURIComponent } from './domainUtils.js';
import { 
  type OriginalKind, 
  type OriginalManifest, 
  type CreateTypedOriginalOptions,
  KindRegistry,
} from '../kinds/index.js';

/**
 * Cost estimation result for migration operations
 */
export interface CostEstimate {
  /** Total estimated cost in satoshis */
  totalSats: number;
  /** Breakdown of costs */
  breakdown: {
    /** Network fee in satoshis */
    networkFee: number;
    /** Data cost for inscription (sat/vB * size) */
    dataCost: number;
    /** Dust output value */
    dustValue: number;
  };
  /** Fee rate used for estimation (sat/vB) */
  feeRate: number;
  /** Data size in bytes */
  dataSize: number;
  /** Target layer for the migration */
  targetLayer: LayerType;
  /** Confidence level of estimate */
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Migration validation result
 */
export interface MigrationValidation {
  /** Whether the migration is valid */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of warnings (non-blocking) */
  warnings: string[];
  /** Current layer of the asset */
  currentLayer: LayerType;
  /** Target layer for migration */
  targetLayer: LayerType;
  /** Checks performed */
  checks: {
    layerTransition: boolean;
    resourcesValid: boolean;
    credentialsValid: boolean;
    didDocumentValid: boolean;
    bitcoinReadiness?: boolean;
  };
}

/**
 * Progress callback for long-running operations
 */
export type ProgressCallback = (progress: LifecycleProgress) => void;

/**
 * Progress information for lifecycle operations
 */
export interface LifecycleProgress {
  /** Current operation phase */
  phase: 'preparing' | 'validating' | 'processing' | 'committing' | 'confirming' | 'complete' | 'failed';
  /** Progress percentage (0-100) */
  percentage: number;
  /** Human-readable message */
  message: string;
  /** Current operation details */
  details?: {
    currentStep?: number;
    totalSteps?: number;
    transactionId?: string;
    confirmations?: number;
  };
}

/**
 * Options for lifecycle operations with progress tracking
 */
export interface LifecycleOperationOptions {
  /** Fee rate for Bitcoin operations (sat/vB) */
  feeRate?: number;
  /** Progress callback for operation updates */
  onProgress?: ProgressCallback;
  /**
   * Enable atomic rollback on failure (default: true).
   *
   * Applies to web publication (publish/publishToWeb): when a later step
   * fails, resource.url mutations from already-published resources are
   * reverted and the written storage objects are best-effort deleted (when
   * the adapter supports deletion; otherwise the orphaned objects are
   * content-addressed and simply overwritten on retry). Bitcoin operations
   * are irreversible by nature and are NOT affected by this flag.
   */
  atomicRollback?: boolean;
}

export class LifecycleManager {
  private eventEmitter: EventEmitter;
  private batchOps: BatchLifecycleOperations;
  private logger: Logger;
  private metrics: MetricsCollector;
  /**
   * Assets with an inscription, publication, or ownership transfer currently
   * in flight, keyed by asset id. Mutated synchronously before the first
   * await so concurrent calls for the same asset cannot both pass the layer
   * guard and double-pay for two inscriptions or broadcast duplicate
   * transfers (issue #255).
   */
  private inFlightAssets = new Set<string>();

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps?: { bitcoinManager?: BitcoinManager },
    private keyStore?: KeyStore,
    metrics?: MetricsCollector
  ) {
    this.eventEmitter = new EventEmitter();
    this.logger = new Logger('LifecycleManager', config);
    this.metrics = metrics || new MetricsCollector();
    // Batch operations delegate per-asset work back to this manager's core
    // methods, and emit through the same event emitter so subscribers via
    // `lifecycle.on(...)` receive batch events.
    this.batchOps = new BatchLifecycleOperations(config, this.eventEmitter, this, this.deps);
  }

  /**
   * Subscribe to a lifecycle event
   * @param eventType - The type of event to subscribe to
   * @param handler - The handler function to call when the event is emitted
   * @returns A function to unsubscribe from the event
   */
  on<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): () => void {
    return this.eventEmitter.on(eventType, handler);
  }

  /**
   * Subscribe to a lifecycle event once
   * @param eventType - The type of event to subscribe to
   * @param handler - The handler function to call when the event is emitted (will only fire once)
   * @returns A function to unsubscribe from the event
   */
  once<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): () => void {
    return this.eventEmitter.once(eventType, handler);
  }

  /**
   * Unsubscribe from a lifecycle event
   * @param eventType - The type of event to unsubscribe from
   * @param handler - The handler function to remove
   */
  off<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): void {
    this.eventEmitter.off(eventType, handler);
  }

  async registerKey(verificationMethodId: string, privateKey: string): Promise<void> {
    if (!this.keyStore) {
      throw new StructuredError('KEYSTORE_REQUIRED', 'KeyStore not configured. Provide keyStore to LifecycleManager constructor.');
    }

    // Validate verification method ID format
    if (!verificationMethodId || typeof verificationMethodId !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Invalid verificationMethodId: must be a non-empty string');
    }

    // Validate private key format (should be multibase encoded)
    if (!privateKey || typeof privateKey !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Invalid privateKey: must be a non-empty string');
    }

    // Validate that it's a valid multibase-encoded private key
    try {
      multikey.decodePrivateKey(privateKey);
    } catch (_err) {
      throw new StructuredError('INVALID_KEY', 'Invalid privateKey format: must be a valid multibase-encoded private key');
    }
    
    await this.keyStore.setPrivateKey(verificationMethodId, privateKey);
  }

  async createAsset(resources: AssetResource[]): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('createAsset');
    const metricsStart = performance.now();
    this.logger.info('Creating asset', { resourceCount: resources.length });
    
    try {
      // Input validation
      if (!Array.isArray(resources)) {
        throw new StructuredError('INVALID_INPUT', 'Resources must be an array. Provide an array of AssetResource objects.');
      }
      if (resources.length === 0) {
        throw new StructuredError('INVALID_INPUT', 'At least one resource is required');
      }

      // Validate each resource
      for (const resource of resources) {
        if (!resource || typeof resource !== 'object') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: must be an object');
        }
        if (!resource.id || typeof resource.id !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid id');
        }
        if (!resource.type || typeof resource.type !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid type');
        }
        if (!resource.contentType || typeof resource.contentType !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid contentType');
        }
        if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid hash (must be hex string)');
        }
        // Validate contentType is a valid MIME type
        if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/.test(resource.contentType)) {
          throw new StructuredError('INVALID_RESOURCE', `Invalid resource: invalid contentType MIME format: ${resource.contentType}`);
        }
        // Inline content must actually match its declared hash: everything
        // downstream (publication credentials, resource URLs, inscription
        // manifests) attests the DECLARED hash, so accepting mismatched
        // content here would let a signed attestation claim integrity that
        // was never true (issue #347).
        this.assertContentMatchesDeclaredHash(resource, 'createAsset');
      }
    
    // Mint the asset's genesis identity as a did:cel derived from a signed CEL
    // create event. The controller key is ALWAYS Ed25519 (CEL is Ed25519-only),
    // independent of config.defaultKeyType. LifecycleManager holds no KeyManager;
    // KeyManager is stateless, so we instantiate one locally.
    const controllerKp = await new KeyManager().generateKeyPair('Ed25519');
    const { signer, verificationMethod } = celSignerFromKeyPair(controllerKp);

    // Bridge AssetResource hashes (hex sha256) to CEL ExternalReferences.
    const externalRefs: ExternalReference[] = resources.map((r) => ({
      digestMultibase: hexSha256ToDigestMultibase(r.hash),
      ...(r.contentType ? { mediaType: r.contentType } : {})
    }));

    // Genesis name = first resource's id (no name param on createAsset by design).
    const manager = new PeerCelManager(signer, { verificationMethod });
    const { log, did } = await manager.create(resources[0]?.id ?? 'asset', externalRefs);

    const didDoc = createCelDidDocument(did, controllerKp.publicKey);

    // Register the controller key under BOTH the did:key VM (CEL signing) and
    // `${did}#key-0` (so signWithKeyStore's `${issuer}#key-0` probe resolves).
    // keyStore-less SDKs still get a fully-formed did:cel asset with its log.
    if (this.keyStore) {
      await this.keyStore.setPrivateKey(verificationMethod, controllerKp.privateKey);
      await this.keyStore.setPrivateKey(`${did}#key-0`, controllerKp.privateKey);
    }

    const asset = new OriginalsAsset(resources, didDoc, [], log);

    // Persist the genesis CEL at the conventional cel/<suffix>.json key so
    // the did:cel resolves from storage immediately (best-effort, never gates).
    await this.persistCelArtifacts(asset);

    // Defer asset:created emission to the next microtask so a handler
    // subscribed on the LifecycleManager emitter immediately before this call
    // still observes it. (Only pre-subscription works — see below.)
    queueMicrotask(() => {
      const event = {
        type: 'asset:created' as const,
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id,
          layer: asset.currentLayer,
          resourceCount: resources.length,
          createdAt: asset.getProvenance().createdAt
        }
      };

      // Emitted only on the LifecycleManager emitter. An asset-level emit
      // here would be dead code: a caller obtains the asset reference only
      // after `await createAsset()` resolves, and this microtask has already
      // run by then, so `(await createAsset()).on('asset:created', ...)` could
      // never fire. Subscribe via `sdk.lifecycle.on('asset:created', ...)`
      // before creating instead.
      void this.eventEmitter.emit(event);
    });

    stopTimer();
    this.logger.info('Asset created successfully', { assetId: asset.id });
    this.metrics.recordOperation('lifecycle.createAsset', performance.now() - metricsStart, true);
    this.metrics.recordAssetCreated();

    return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Asset creation failed', error as Error, { resourceCount: resources.length });
      this.metrics.recordOperation('lifecycle.createAsset', performance.now() - metricsStart, false);
      this.metrics.recordError('ASSET_CREATION_FAILED', 'createAsset');
      throw error;
    }
  }

  /**
   * Reconstruct an asset from a serialized {@link AssetEnvelope} — the buyer
   * half of the interchange format (#377). Inverse of {@link OriginalsAsset.serialize}.
   *
   * VERIFIES BY DEFAULT: parses and structurally validates the envelope, then
   * (unless `skipVerification`) runs the SAME cryptographic gate the live verify
   * path uses — `verifyEventLog` bound to `assetDid`, the resource↔genesis
   * binding, per-resource inline-content hashes, and DID-doc↔fold cross-checks —
   * before folding the log into provenance and rebuilding via
   * {@link OriginalsAsset.restore}. Every failure is fail-closed.
   *
   * The `unverified.*` honesty section is passed through as advisory only and is
   * NEVER promoted to trusted state: a `unverified.bindings['did:btco']` the fold
   * cannot derive from the log is surfaced in `warnings`, not in `asset.bindings`.
   *
   * @param envelope - The envelope object or its JSON string.
   * @param opts.skipVerification - Skip the cryptographic + binding checks ONLY;
   *   structural validation (format/version/required fields) always runs.
   * @param opts.ordinalsProvider - Ordinals lookup for bitcoin witness proofs;
   *   defaults to `config.ordinalsProvider`. btco-anchored logs fail closed
   *   without one.
   * @throws StructuredError('ENVELOPE_INVALID') for malformed envelopes.
   * @throws StructuredError('ENVELOPE_VERSION_UNSUPPORTED') for a version newer
   *   than this SDK supports.
   * @throws StructuredError('ASSET_LOAD_VERIFICATION_FAILED', …, { verification })
   *   when verification or any binding/cross-check fails.
   */
  async loadAsset(
    envelope: AssetEnvelope | string,
    opts?: { skipVerification?: boolean; ordinalsProvider?: OrdinalsLookup }
  ): Promise<{ asset: OriginalsAsset; verification?: VerificationResult; warnings: string[] }> {
    // 1) Structural validation (ALWAYS runs, even under skipVerification).
    let env: AssetEnvelope;
    if (typeof envelope === 'string') {
      try {
        env = JSON.parse(envelope) as AssetEnvelope;
      } catch (e) {
        throw new StructuredError('ENVELOPE_INVALID', `Envelope is not valid JSON: ${(e as Error).message}`);
      }
    } else {
      env = envelope;
    }
    if (!env || typeof env !== 'object') {
      throw new StructuredError('ENVELOPE_INVALID', 'Envelope must be an object or a JSON string.');
    }
    if (env.format !== ASSET_ENVELOPE_FORMAT) {
      throw new StructuredError('ENVELOPE_INVALID', `Unrecognized envelope format: ${String(env.format)} (expected ${ASSET_ENVELOPE_FORMAT}).`);
    }
    if (!Number.isInteger(env.version)) {
      throw new StructuredError('ENVELOPE_INVALID', `Envelope version must be an integer; got ${String(env.version)}.`);
    }
    if (env.version > ASSET_ENVELOPE_VERSION) {
      throw new StructuredError('ENVELOPE_VERSION_UNSUPPORTED', `Envelope version ${env.version} is newer than this SDK supports (max ${ASSET_ENVELOPE_VERSION}).`);
    }
    if (typeof env.assetDid !== 'string' || !env.assetDid) {
      throw new StructuredError('ENVELOPE_INVALID', 'Envelope is missing a valid assetDid.');
    }
    if (!env.eventLog || typeof env.eventLog !== 'object') {
      throw new StructuredError('ENVELOPE_INVALID', 'Envelope is missing a valid eventLog.');
    }
    if (!env.didDocuments || typeof env.didDocuments !== 'object' || !env.didDocuments['did:cel']) {
      throw new StructuredError('ENVELOPE_INVALID', "Envelope is missing didDocuments['did:cel'].");
    }
    if (!Array.isArray(env.resources) || env.resources.length === 0) {
      throw new StructuredError('ENVELOPE_INVALID', 'Envelope must carry a non-empty resources array.');
    }

    // 2) Log parsing through the JSON gate (validates structure, decouples from
    // the caller's object, preserves witness-proof extension fields).
    let log: EventLog;
    try {
      log = parseEventLogJson(JSON.stringify(env.eventLog));
    } catch (e) {
      throw new StructuredError('ENVELOPE_INVALID', `Envelope eventLog is not a valid CEL log: ${(e as Error).message}`);
    }

    // The fold is needed to rebuild the asset regardless of verification.
    const folded = replayProvenance(log);

    // 3-5) Verification + binding + cross-checks (skipped by skipVerification).
    const provider = opts?.ordinalsProvider ?? this.config.ordinalsProvider;
    let verification: VerificationResult | undefined;
    if (!opts?.skipVerification) {
      verification = await verifyEventLog(log, {
        expectedDid: env.assetDid,
        resolveKey: createDidManagerKeyResolver(this.didManager),
        ordinalsProvider: provider,
        // A provider lets us reject a truncated pre-rotation log handed off by a
        // seller (#366); its on-chain head betrays the omission.
        checkHeadFreshness: provider !== undefined
      });
      if (!verification.verified) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          `Event log failed verification for ${env.assetDid}. Refusing to load an asset whose provenance does not verify.`,
          { verification }
        );
      }

      // 4) Resource↔genesis binding (shared helper) + inline-content hashes.
      if (!checkGenesisResourceBinding(log, env.resources)) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          'Envelope resources do not back the log genesis (a genesis resource digest is missing).',
          { verification }
        );
      }
      for (const res of env.resources) {
        if (typeof res.content === 'string') {
          const computed = hashResource(Buffer.from(res.content, 'utf8'));
          if (computed.toLowerCase() !== String(res.hash).toLowerCase()) {
            throw new StructuredError(
              'ASSET_LOAD_VERIFICATION_FAILED',
              `Resource ${res.id}: inline content does not match its declared hash (declared ${res.hash}, computed ${computed}).`,
              { verification }
            );
          }
        }
      }

      // 5) Cross-checks: the fold IS the source of truth for identity/bindings;
      // an envelope's advisory DID docs must not disagree with it — a swapped
      // doc is exactly the attack the envelope invites. did:cel is bound by the
      // genesis derivation; webvh/btco docs must match the folded binding when
      // the fold derived one (a degraded btco binding has none — see step 7).
      if (!didCelMatchesLog(env.assetDid, log)) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          `assetDid ${env.assetDid} does not derive from the log genesis.`,
          { verification }
        );
      }
      const webvhDoc = env.didDocuments['did:webvh'];
      if (webvhDoc && folded.bindings['did:webvh'] && webvhDoc.id !== folded.bindings['did:webvh']) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          `didDocuments['did:webvh'].id (${webvhDoc.id}) does not match the folded binding (${folded.bindings['did:webvh']}).`,
          { verification }
        );
      }
      const btcoDoc = env.didDocuments['did:btco'];
      if (btcoDoc && folded.bindings['did:btco'] && btcoDoc.id !== folded.bindings['did:btco']) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          `didDocuments['did:btco'].id (${btcoDoc.id}) does not match the folded binding (${folded.bindings['did:btco']}).`,
          { verification }
        );
      }
    }

    // 6) Assemble provenance from the (verified) log + fold + advisory unverified.
    const warnings: string[] = [];
    // Freshness could not be checked (#366): a btco-anchored log without a
    // provider cannot be tested against its on-chain head, so a truncated
    // pre-rotation hand-off would go undetected. Surface it — do not fail.
    if (!provider && folded.currentLayer === 'did:btco') {
      warnings.push(
        'Loaded a btco-anchored asset without an ordinals provider: head freshness was NOT checked, so a ' +
        'truncated (pre-rotation/pre-transfer) log cannot be ruled out. Re-load with a provider to verify freshness.'
      );
    }
    const provenance = this.buildRestoredProvenance(log, folded, env, warnings);

    const asset = OriginalsAsset.restore(
      env.resources.map(r => ({ ...r })),
      structuredClone(env.didDocuments['did:cel']),
      (env.credentials ?? []).map(c => ({ ...c })),
      log,
      { currentLayer: folded.currentLayer, bindings: folded.bindings, provenance }
    );

    // Repopulate captured DID docs so re-serializing a loaded asset is
    // lossless. Only for layers cross-checked against the fold in step 5
    // above; a degraded/absent binding must not be backfilled here either.
    for (const layer of ['did:webvh', 'did:btco'] as const) {
      const doc = env.didDocuments[layer];
      if (folded.bindings[layer] && doc) {
        asset._captureDidDocument(layer, doc);
      }
    }

    return { asset, verification, warnings };
  }

  /**
   * Verify an already-live asset using the manager's own DID/credential
   * resolvers, so callers don't have to hand-thread them (`asset.verify()`
   * called directly requires deps the caller may not have handy).
   *
   * @param overrides.ordinalsProvider - Defaults to `config.ordinalsProvider`.
   *   btco-anchored logs fail closed without one (same contract as loadAsset).
   */
  async verifyAsset(
    asset: OriginalsAsset,
    overrides?: { ordinalsProvider?: OrdinalsLookup }
  ): Promise<boolean> {
    return asset.verify({
      didManager: this.didManager,
      credentialManager: this.credentialManager,
      ordinalsProvider: overrides?.ordinalsProvider ?? this.config.ordinalsProvider
    });
  }

  /**
   * Fold the log into a {@link ProvenanceChain} for restore(). createdAt/creator
   * come from the genesis data; migrations are re-materialized in the live
   * layer-to-layer shape (enriched from bitcoin witness proofs + advisory
   * `unverified.commitTxId`/`feeRate`); transfers come from the fold; the
   * `unverified.bindings` degraded btco binding is NEVER promoted — surfaced in
   * `warnings` instead (step 7).
   */
  private buildRestoredProvenance(
    log: EventLog,
    folded: ReturnType<typeof replayProvenance>,
    env: AssetEnvelope,
    warnings: string[]
  ): ProvenanceChain {
    const genesisData = (log.events[0]?.data ?? {}) as Record<string, unknown>;
    const createdAt = typeof genesisData.createdAt === 'string' ? genesisData.createdAt : '';
    const creator = typeof genesisData.controller === 'string'
      ? genesisData.controller
      : typeof genesisData.creator === 'string'
        ? genesisData.creator
        : env.assetDid;

    // Re-materialize migrations layer-to-layer by walking the log.
    const migrations: ProvenanceChain['migrations'] = [];
    let layer: LayerType = 'did:peer';
    for (let i = 1; i < log.events.length; i++) {
      const ev = log.events[i];
      if (ev.type !== 'migrate') continue;
      const data = (ev.data ?? {}) as Record<string, unknown>;
      const timestamp = typeof data.migratedAt === 'string' ? data.migratedAt : '';
      if (data.layer === 'webvh') {
        migrations.push({ from: layer, to: 'did:webvh', timestamp });
        layer = 'did:webvh';
      } else if (data.layer === 'btco') {
        const wp = this.extractBitcoinWitnessProof(ev);
        migrations.push({
          from: layer,
          to: 'did:btco',
          timestamp,
          transactionId: wp?.txid,
          inscriptionId: wp?.inscriptionId,
          satoshi: wp?.satoshi,
          commitTxId: env.unverified?.commitTxId,
          revealTxId: wp?.txid,
          feeRate: env.unverified?.feeRate
        });
        layer = 'did:btco';
      }
    }

    const transfers = folded.transfers.map(t => ({
      from: t.from,
      to: t.to,
      timestamp: t.timestamp,
      transactionId: t.transactionId ?? ''
    }));

    const resourceUpdates = (env.unverified?.resourceUpdates ?? []).map(u => ({ ...u }));

    // txid: last transfer wins, else the btco migration's witnessed reveal txid.
    const lastTransfer = transfers[transfers.length - 1];
    const lastBtco = [...migrations].reverse().find(m => m.to === 'did:btco');
    const txid = lastTransfer?.transactionId || lastBtco?.transactionId;

    // 7) Degraded binding: fold couldn't derive btco but the honesty section
    // carries one — do NOT promote; surface as advisory.
    const advisoryBtco = env.unverified?.bindings?.['did:btco'];
    if (!folded.bindings['did:btco'] && advisoryBtco) {
      warnings.push(
        `did:btco binding (${advisoryBtco}) is present only in unverified.bindings and is not derivable from the log; ` +
        `it was NOT promoted to a trusted binding (advisory only).`
      );
    }

    const provenance: ProvenanceChain = { createdAt, creator, migrations, transfers, resourceUpdates };
    if (txid) provenance.txid = txid;
    return provenance;
  }

  /** Extract the bitcoin witness proof fields from a migrate event, if present. */
  private extractBitcoinWitnessProof(event: LogEntry): { txid?: string; satoshi?: string; inscriptionId?: string } | undefined {
    const proofs = event.proof as ReadonlyArray<unknown> | undefined;
    const bp = proofs?.find(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
    );
    if (!bp) return undefined;
    return {
      txid: typeof bp.txid === 'string' ? bp.txid : undefined,
      satoshi: typeof bp.satoshi === 'string' ? bp.satoshi : undefined,
      inscriptionId: typeof bp.inscriptionId === 'string' ? bp.inscriptionId : undefined
    };
  }

  /**
   * Create a typed Original with kind-specific validation
   * 
   * This is the recommended way to create Originals with proper typing and validation.
   * Each kind (App, Agent, Module, Dataset, Media, Document) has specific metadata
   * requirements that are validated before creation.
   * 
   * @param kind - The kind of Original to create
   * @param manifest - The manifest containing name, version, resources, and kind-specific metadata
   * @param options - Optional creation options (skipValidation, strictMode)
   * @returns The created OriginalsAsset
   * @throws Error if validation fails (unless skipValidation is true)
   * 
   * @example
   * ```typescript
   * // Create a Module Original
   * const moduleAsset = await sdk.lifecycle.createTypedOriginal(
   *   OriginalKind.Module,
   *   {
   *     kind: OriginalKind.Module,
   *     name: 'my-utility',
   *     version: '1.0.0',
   *     resources: [{ id: 'index.js', type: 'code', hash: '...', contentType: 'application/javascript' }],
   *     metadata: {
   *       format: 'esm',
   *       main: 'index.js',
   *     }
   *   }
   * );
   * ```
   */
  async createTypedOriginal<K extends OriginalKind>(
    kind: K,
    manifest: OriginalManifest<K>,
    options?: CreateTypedOriginalOptions
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('createTypedOriginal');
    this.logger.info('Creating typed Original', { kind, name: manifest.name, version: manifest.version });
    
    try {
      // Verify kind matches
      if (manifest.kind !== kind) {
        throw new StructuredError('INVALID_INPUT', `Manifest kind "${manifest.kind}" does not match requested kind "${kind}"`);
      }
      
      // Validate manifest using KindRegistry
      const registry = KindRegistry.getInstance();
      registry.validateOrThrow(manifest, options);
      
      // Log warnings if any
      if (!options?.skipValidation) {
        const validationResult = registry.validate(manifest, options);
        if (validationResult.warnings.length > 0) {
          for (const warning of validationResult.warnings) {
            this.logger.warn(`[${warning.code}] ${warning.message}`, { path: warning.path });
          }
        }
      }
      
      // Create the asset using existing createAsset method
      const asset = await this.createAsset(manifest.resources);
      
      // Store the manifest metadata on the asset for future reference
      // We attach it as a non-enumerable property to avoid serialization issues
      Object.defineProperty(asset, '_manifest', {
        value: manifest,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      
      // createAsset already emitted asset:created and recorded the metric for
      // this asset; emitting/recording again here made every typed Original
      // double-fire the event and double-count in metrics.

      stopTimer();
      this.logger.info('Typed Original created successfully', {
        assetId: asset.id,
        kind,
        name: manifest.name,
        version: manifest.version,
      });
      
      return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Typed Original creation failed', error as Error, { 
        kind,
        name: manifest.name,
        version: manifest.version,
      });
      this.metrics.recordError('TYPED_ASSET_CREATION_FAILED', 'createTypedOriginal');
      throw error;
    }
  }

  /**
   * Get the manifest from a typed Original asset
   * Returns undefined if the asset was not created with createTypedOriginal
   * 
   * @param asset - The OriginalsAsset to get manifest from
   * @returns The manifest or undefined
   */
  getManifest<K extends OriginalKind>(asset: OriginalsAsset): OriginalManifest<K> | undefined {
    return (asset as { _manifest?: OriginalManifest<K> })._manifest;
  }

  /**
   * Estimate the cost of creating a typed Original
   * Useful for showing users estimated fees before creation
   * 
   * @param manifest - The manifest to estimate
   * @param targetLayer - The target layer (did:webvh or did:btco)
   * @param feeRate - Optional fee rate override (sat/vB)
   * @returns Cost estimate including fees
   */
  async estimateTypedOriginalCost<K extends OriginalKind>(
    manifest: OriginalManifest<K>,
    targetLayer: LayerType,
    feeRate?: number
  ): Promise<CostEstimate> {
    // For webvh, costs are minimal
    if (targetLayer === 'did:webvh') {
      return {
        totalSats: 0,
        breakdown: {
          networkFee: 0,
          dataCost: 0,
          dustValue: 0
        },
        feeRate: 0,
        dataSize: 0,
        targetLayer,
        confidence: 'high'
      };
    }
    
    // Calculate total data size including manifest metadata
    let dataSize = 0;
    for (const resource of manifest.resources) {
      if (resource.size) {
        dataSize += resource.size;
      } else if (resource.content) {
        dataSize += Buffer.from(resource.content).length;
      } else {
        // Estimate based on hash length (assume average resource size)
        dataSize += 1000;
      }
    }
    
    // Add inscription manifest overhead
    const inscriptionManifest = {
      assetId: `did:peer:placeholder`,
      kind: manifest.kind,
      name: manifest.name,
      version: manifest.version,
      resources: manifest.resources.map(r => ({
        id: r.id,
        hash: r.hash,
        contentType: r.contentType,
      })),
      metadata: manifest.metadata,
      timestamp: new Date().toISOString()
    };
    dataSize += Buffer.from(JSON.stringify(inscriptionManifest)).length;
    
    // Get fee rate from oracle or use provided/default
    let effectiveFeeRate = feeRate;
    let confidence: 'low' | 'medium' | 'high' = 'medium';
    
    if (!effectiveFeeRate) {
      if (this.config.feeOracle) {
        try {
          effectiveFeeRate = this.capEstimatedFeeRate(await this.config.feeOracle.estimateFeeRate(1));
          confidence = 'high';
        } catch {
          // Fallback to default
        }
      }

      if (!effectiveFeeRate && this.config.ordinalsProvider) {
        try {
          effectiveFeeRate = this.capEstimatedFeeRate(await this.config.ordinalsProvider.estimateFee(1));
          confidence = 'medium';
        } catch {
          // Fallback to default
        }
      }

      if (!effectiveFeeRate) {
        effectiveFeeRate = 10;
        confidence = 'low';
      }
    }
    
    // Transaction overhead (commit + reveal structure)
    const txOverhead = 200 + 122; // Base tx + inscription overhead
    const totalVbytes = txOverhead + Math.ceil(dataSize / 4); // Witness data is ~1/4 weight
    
    const networkFee = totalVbytes * effectiveFeeRate;
    const dustValue = 330; // Minimum output value
    
    return {
      totalSats: networkFee + dustValue,
      breakdown: {
        networkFee,
        dataCost: Math.ceil(dataSize / 4) * effectiveFeeRate,
        dustValue
      },
      feeRate: effectiveFeeRate,
      dataSize,
      targetLayer,
      confidence
    };
  }

  async publishToWeb(
    asset: OriginalsAsset,
    publisherDidOrSigner: string | ExternalSigner,
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('publishToWeb');
    const metricsStart = performance.now();

    try {
      if (asset.currentLayer !== 'did:peer') {
        throw new StructuredError('INVALID_STATE', 'Asset must be in did:peer layer to publish to web. Assets can only be published from the did:peer layer.');
      }

      // Concurrency guard (issue #255): the layer check above is
      // check-then-act across awaits — overlapping publishes would both pass
      // it and duplicate storage writes/credentials.
      if (this.inFlightAssets.has(asset.id)) {
        throw new StructuredError(
          'OPERATION_IN_PROGRESS',
          `An inscription or publication for asset ${asset.id} is already in progress.`
        );
      }
      this.inFlightAssets.add(asset.id);
      try {
      const { publisherDid, signer } = this.extractPublisherInfo(publisherDidOrSigner);
      // Publisher DID contributes only the domain; the hosting path comes
      // from the minted DID below.
      const { domain } = this.parseWebVHDid(publisherDid);

      this.logger.info('Publishing asset to web', { assetId: asset.id, domain });

      // atomicRollback (default: true — the option was documented but never
      // consumed): capture pre-publish resource urls and track written
      // objects so a mid-publish failure does not leave the asset
      // half-published (some resources with url set + orphaned storage
      // writes) while the caller sees a plain failure.
      const atomicRollback = options?.atomicRollback !== false;
      const urlSnapshots = asset.resources.map((resource: { url?: string }) => ({
        resource,
        url: resource.url
      }));
      const writtenObjects: Array<{ domain: string; relativePath: string }> = [];

      // Capture the layer before migration (always 'did:peer' here due to the
      // guard above, but captured dynamically for correctness).
      const priorLayer = asset.currentLayer;

      // Snapshot the CEL log so a mid-publish failure after the migrate append
      // can restore it (alongside the resource-url/storage rollback).
      const logBefore = asset.celLog;

      try {
        // Mint the asset's OWN did:webvh — genuine SCID, signed genesis log,
        // alsoKnownAs back-link to the peer DID (#376). The publisher argument
        // contributes the domain and (optionally) the log-signing authority.
        const migration = await this.didManager.migrateToDIDWebVH(
          asset.did,
          domain,
          signer ? { externalSigner: signer } : {}
        );

        // Persist the update key so the minted DID stays updatable. Without a
        // keyStore the DID still exists but cannot be rotated later — surface
        // that instead of silently dropping the key.
        const keyStore = this.keyStore;
        let newVmId = migration.didDocument.verificationMethod?.[0]?.id;
        // Normalize a fragment id to absolute (mirror createAsset's peer-key registration).
        if (newVmId && newVmId.startsWith('#')) {
          newVmId = `${migration.did}${newVmId}`;
        }
        if (migration.keyPair && keyStore && newVmId) {
          await keyStore.setPrivateKey(newVmId, migration.keyPair.privateKey);
        } else if (migration.keyPair && !keyStore) {
          await this.eventEmitter.emit({
            type: 'key:unpersisted',
            timestamp: new Date().toISOString(),
            asset: { id: asset.id },
            did: migration.did
          });
        }

        // Host resources under the MINTED DID (urls now belong to the asset):
        // derive the storage path from migration.did, not the publisher
        // shorthand, or the URL and the stored bytes diverge (stale ":user").
        const minted = this.parseWebVHDid(migration.did);
        await this.publishResources(asset, migration.did, minted.domain, minted.userPath, writtenObjects);

        // Append the signed `migrate` event to the asset's CEL — the first
        // lifecycle append. Signed by the CURRENT controller (folded from the
        // log). Degraded modes: no keyStore to sign with, or a legacy asset
        // with no CEL log — skip the append + cel.json hosting and surface why.
        // Publish must not hard-require a keyStore in Phase 2.
        const migratedAt = new Date().toISOString();
        // Routed through the shared choke point (same guards/degrade contract
        // as transfer/rotate) — as a side effect this also refreshes
        // cel/<suffix>.json via persistCelArtifacts on every publish append,
        // not just later transfer/rotate ones (carry-forward #3).
        const celHeadDigest = await this.appendCelEventOrSkip(asset, 'migrate', {
          sourceDid: asset.id,
          targetDid: migration.did,
          layer: 'webvh',
          domain: minted.domain,
          migratedAt
        });
        const celAppended = celHeadDigest !== null;

        // Host the signed DID log so the DID actually resolves.
        await this.hostDIDLog(migration.did, migration.log, writtenObjects);

        // Host the CEL beside did.jsonl (only when the migrate event was
        // appended, so the hosted log includes it).
        if (celAppended) {
          await this.hostCelLog(migration.did, asset.celLog!, writtenObjects);
        }

        const sourceDid = asset.id;
        await asset.migrate('did:webvh');
        asset.bindings = {
          ...(asset.bindings || {}),
          'did:cel': sourceDid,
          'did:webvh': migration.did
        };

        // Mirror onto the manager emitter: asset.migrate emits only on the
        // asset's private emitter, so sdk.lifecycle.on('asset:migrated', ...)
        // subscriptions (and the built-in EventLogger) never fired (issue #346).
        await this.eventEmitter.emit({
          type: 'asset:migrated',
          timestamp: new Date().toISOString(),
          asset: { id: asset.id, fromLayer: priorLayer, toLayer: 'did:webvh' }
        });

        // Retain the minted webvh DID doc for serialize() (the live flow reads
        // only its VM id and otherwise discards it) — captured after the
        // same-try emit so the capture only lands once this step is fully
        // committed (mirrors inscribeOnBitcoin's post-migrate capture).
        asset._captureDidDocument('did:webvh', migration.didDocument);
      } catch (publishError) {
        if (atomicRollback) {
          await this.rollbackPartialPublish(asset, urlSnapshots, writtenObjects);
          // Revert the migrate append if it landed before the failure.
          if (logBefore && asset.celLog !== logBefore) {
            asset._replaceCelLog(logBefore);
          }
        }
        throw publishError;
      }

      // Issue the peer-key-signed migration credential (best-effort).
      await this.issuePublicationCredential(asset, asset.bindings['did:webvh'], signer);

      stopTimer();
      this.logger.info('Asset published to web successfully', { 
        assetId: asset.id, 
        publisherDid, 
        resourceCount: asset.resources.length 
      });
      this.metrics.recordOperation('lifecycle.publishToWeb', performance.now() - metricsStart, true);
      this.metrics.recordMigration('did:peer', 'did:webvh');

      return asset;
      } finally {
        this.inFlightAssets.delete(asset.id);
      }
    } catch (error) {
      stopTimer();
      this.logger.error('Publish to web failed', error as Error, { assetId: asset.id });
      this.metrics.recordOperation('lifecycle.publishToWeb', performance.now() - metricsStart, false);
      this.metrics.recordError('PUBLISH_FAILED', 'publishToWeb');
      throw error;
    }
  }

  // NOTE: the fabricated did:webvh:{domain}:user shorthand never leaves this
  // class anymore — it is parsed for its domain only. The asset's real
  // did:webvh is minted in publishToWeb via DIDManager.migrateToDIDWebVH (#376).
  private extractPublisherInfo(publisherDidOrSigner: string | ExternalSigner): {
    publisherDid: string;
    signer?: ExternalSigner;
  } {
    if (typeof publisherDidOrSigner === 'string') {
      // If it's already a did:webvh DID, use it as-is
      if (publisherDidOrSigner.startsWith('did:webvh:')) {
        return { publisherDid: publisherDidOrSigner };
      }

      // Otherwise, treat it as a domain and construct a did:webvh DID.
      // Validate AND normalize before encoding so the DID is built from the
      // same normalized form that validation checked (avoids whitespace/case
      // drift between validation and the value actually encoded).
      const normalizedDomain = validateAndNormalizeDomain(publisherDidOrSigner);
      // Encode the domain to handle ports (e.g., localhost:5000 -> localhost%3A5000)
      const encodedDomain = encodeURIComponent(normalizedDomain);
      const publisherDid = `did:webvh:${encodedDomain}:user`;
      return { publisherDid };
    }

    const signer = publisherDidOrSigner;
    const resolvedVmId = signer.getVerificationMethodId();
    const publisherDid = resolvedVmId.includes('#') ? resolvedVmId.split('#')[0] : resolvedVmId;

    if (!publisherDid.startsWith('did:webvh:')) {
      throw new StructuredError('INVALID_INPUT', 'Signer must be associated with a did:webvh identifier');
    }

    return { publisherDid, signer };
  }

  private parseWebVHDid(did: string): { domain: string; userPath: string } {
    if (!did.startsWith('did:webvh:')) {
      throw new StructuredError('INVALID_DID', 'Invalid did:webvh format: must start with did:webvh:');
    }
    const parts = did.split(':');
    if (parts.length < 4) {
      throw new StructuredError('INVALID_DID', 'Invalid did:webvh format: must include domain and user path');
    }

    // Two shapes reach this method and the domain lives in a different
    // position in each:
    //   - canonical resolved/migrated DID: did:webvh:{SCID}:{domain}[:paths]
    //     (the SCID at parts[2] is a dotless multibase string, never a domain)
    //   - the domain shorthand built by extractPublisherInfo:
    //     did:webvh:{domain}:user
    // Disambiguate by asking whether parts[2] is itself a valid domain: a real
    // domain has a dot or is `localhost`, so it validates; a SCID does not.
    // This keeps the storage layout aligned with WebVHManager.saveDIDLog
    // (domain-first, SCID excluded), which the old parts[2]-is-domain
    // assumption broke.
    let domainIndex: number;
    let normalizedDomain: string;
    const decodedSegment2 = safeDecodeURIComponent(parts[2]);
    const domainFromSegment2 = tryValidateDomain(decodedSegment2);
    if (domainFromSegment2 !== null) {
      domainIndex = 2;
      normalizedDomain = domainFromSegment2;
    } else {
      // parts[2] is a SCID; the domain is the next segment.
      normalizedDomain = validateAndNormalizeDomain(safeDecodeURIComponent(parts[3]));
      domainIndex = 3;
    }

    // Every path segment after the domain feeds directly into storage keys
    // (`${domain}/${userPath}/...`), so validate each the same way
    // WebVHManager.saveDIDLog does (issue #274). Without this, a DID like
    // did:webvh:{SCID}:example.com:..:..:x — or a segment that percent-decodes
    // to `..` — lets path-hierarchy-backed storage adapters write outside
    // their root.
    const segments = parts.slice(domainIndex + 1);
    for (const rawSegment of segments) {
      const segment = safeDecodeURIComponent(rawSegment);
      if (
        rawSegment === '' ||
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        segment.includes('\0')
      ) {
        throw new StructuredError('INVALID_DID', `Invalid did:webvh path segment: ${rawSegment}`);
      }
    }
    const userPath = segments.join('/');

    return { domain: normalizedDomain, userPath };
  }

  /**
   * Best-effort undo of a partially completed publish (atomicRollback):
   * restores the pre-publish resource.url values and deletes written storage
   * objects when the adapter supports deletion (deleteObject(domain, path) or
   * legacy delete(key)). Shipped adapters have no delete — their orphaned
   * objects are content-addressed under deterministic keys, so a retry simply
   * overwrites them; only the in-memory url reverts matter for consistency.
   */
  private async rollbackPartialPublish(
    asset: OriginalsAsset,
    urlSnapshots: Array<{ resource: { url?: string }; url?: string }>,
    writtenObjects: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    for (const { resource, url } of urlSnapshots) {
      if (url === undefined) {
        delete resource.url;
      } else {
        resource.url = url;
      }
    }

    if (writtenObjects.length === 0) return;
    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter as
      | {
          deleteObject?: (domain: string, path: string) => Promise<unknown>;
          delete?: (key: string) => Promise<unknown>;
        }
      | undefined;
    if (!storage) return;

    for (const { domain, relativePath } of writtenObjects) {
      try {
        if (typeof storage.deleteObject === 'function') {
          await storage.deleteObject(domain, relativePath);
        } else if (typeof storage.delete === 'function') {
          await storage.delete(`${domain}/${relativePath}`);
        } else {
          this.logger.warn('atomicRollback: storage adapter has no delete; leaving orphaned object (overwritten on retry)', {
            assetId: asset.id,
            domain,
            path: relativePath
          });
          break; // same adapter for every object: no point iterating further
        }
      } catch (deleteError) {
        this.logger.warn('atomicRollback: failed to delete partially published object', {
          assetId: asset.id,
          domain,
          path: relativePath,
          error: (deleteError as Error)?.message ?? String(deleteError)
        });
      }
    }
  }

  /**
   * Verify that a resource's inline content actually hashes to its declared
   * hash. The SDK's integrity semantics (OriginalsAsset.verify,
   * addResourceVersion) define a resource hash as sha256 over the UTF-8
   * bytes of `content`. Publication writes content to a key derived from the
   * DECLARED hash, sets resource.url, and mints a signed ResourceMigrated
   * credential — none of which is sound if the bytes don't match (issue
   * #347). Hash-only resources (no inline content) are not checkable here
   * and are skipped.
   */
  private assertContentMatchesDeclaredHash(resource: AssetResource, operation: string): void {
    if (typeof resource.content !== 'string') return;
    const computed = hashResource(Buffer.from(resource.content, 'utf8'));
    if (computed.toLowerCase() !== resource.hash.toLowerCase()) {
      throw new StructuredError(
        'RESOURCE_HASH_MISMATCH',
        `Resource ${resource.id}: content does not match its declared hash ` +
        `(declared ${resource.hash}, computed ${computed}). Refusing to ${operation}: ` +
        `attesting a hash the bytes do not match would break provenance.`
      );
    }
  }

  /**
   * Derives the storage location for a sibling file (did.jsonl, cel.json) under
   * a did:webvh, mirroring WebVHManager.saveDIDLog's resolution layout:
   * did:webvh:{SCID}:{domain}:p1:p2 -> {domain}/p1/p2/{filename}, no-path DIDs
   * -> {domain}/.well-known/{filename}.
   */
  private webvhStorageLocation(did: string, filename: string): { domain: string; relativePath: string } {
    const parts = did.split(':');
    if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
      throw new StructuredError('INVALID_DID', `Cannot host ${filename} for non-webvh DID: ${did}`);
    }
    const domain = decodeURIComponent(parts[3]);
    const pathParts = parts.slice(4);
    const relativePath = pathParts.length
      ? `${pathParts.join('/')}/${filename}`
      : `.well-known/${filename}`;
    return { domain, relativePath };
  }

  /**
   * Hosts the signed did:webvh log as JSONL through the storage adapter (see
   * webvhStorageLocation for the layout). No storage adapter is a degraded (but
   * allowed) mode: the DID exists and the signed log is returned to the caller,
   * but nothing hosts it — surfaced via event.
   */
  private async hostDIDLog(
    did: string,
    log: unknown,
    writtenObjects?: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    const { domain, relativePath } = this.webvhStorageLocation(did, 'did.jsonl');

    // A non-array or empty log would serialize to a zero-byte did.jsonl that
    // silently serves an unresolvable DID. Surface it via event and write
    // nothing, mirroring the NO_STORAGE_ADAPTER degraded mode below.
    if (!Array.isArray(log) || log.length === 0) {
      await this.eventEmitter.emit({
        type: 'did:log-unhosted',
        timestamp: new Date().toISOString(),
        did,
        reason: 'EMPTY_LOG'
      });
      return;
    }
    const jsonl = log.map((e) => JSON.stringify(e)).join('\n');

    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    const withPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<unknown> } | undefined;
    const withPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<unknown> } | undefined;

    if (withPut && typeof withPut.put === 'function') {
      await withPut.put(`${domain}/${relativePath}`, Buffer.from(jsonl), { contentType: 'application/jsonl' });
      writtenObjects?.push({ domain, relativePath });
    } else if (withPutObject && typeof withPutObject.putObject === 'function') {
      await withPutObject.putObject(domain, relativePath, new TextEncoder().encode(jsonl));
      writtenObjects?.push({ domain, relativePath });
    } else {
      await this.eventEmitter.emit({
        type: 'did:log-unhosted',
        timestamp: new Date().toISOString(),
        did,
        reason: 'NO_STORAGE_ADAPTER'
      });
    }
  }

  /**
   * Hosts the asset's CEL as `cel.json` beside its `did.jsonl` (same webvh
   * storage layout), serialized with the deterministic JSON serializer. A
   * missing storage adapter is a no-op: the DID log's own NO_STORAGE_ADAPTER
   * event already surfaces the un-hosted state for this publish.
   */
  private async hostCelLog(
    did: string,
    log: EventLog,
    writtenObjects?: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    const { domain, relativePath } = this.webvhStorageLocation(did, 'cel.json');
    const json = serializeEventLogJson(log);

    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    const withPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<unknown> } | undefined;
    const withPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<unknown> } | undefined;

    if (withPut && typeof withPut.put === 'function') {
      await withPut.put(`${domain}/${relativePath}`, Buffer.from(json), { contentType: 'application/json' });
      writtenObjects?.push({ domain, relativePath });
    } else if (withPutObject && typeof withPutObject.putObject === 'function') {
      await withPutObject.putObject(domain, relativePath, new TextEncoder().encode(json));
      writtenObjects?.push({ domain, relativePath });
    }
  }

  /**
   * Best-effort persistence of the asset's CEL, called at genesis and after
   * every successful append (the appendCelEventOrSkip choke point):
   * 1. the layer-agnostic copy at `cel/<didCelSuffix>.json` — the conventional
   *    key DIDManager.resolveDID's did:cel branch reads back; and
   * 2. when the asset is bound to a did:webvh, a refresh of the hosted
   *    `cel.json` so the published copy is not frozen at publish time.
   * NEVER gates the lifecycle op: any failure surfaces as a `cel:host-failed`
   * warn event and nothing is thrown. No storage adapter is a silent no-op
   * (same contract as hostCelLog).
   */
  private async persistCelArtifacts(asset: OriginalsAsset): Promise<void> {
    const log = asset.celLog;
    if (!log) return;
    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    if (!storage) return;

    try {
      const suffix = deriveDidCel(log).slice(DID_CEL_PREFIX.length);
      const json = serializeEventLogJson(log);
      const withPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<unknown> };
      const withPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<unknown> };
      if (typeof withPut.put === 'function') {
        await withPut.put(`cel/${suffix}.json`, Buffer.from(json), { contentType: 'application/json' });
      } else if (typeof withPutObject.putObject === 'function') {
        await withPutObject.putObject('cel', `${suffix}.json`, new TextEncoder().encode(json));
      }
    } catch (err) {
      await this.emitCelHostFailed(asset.id, 'cel-copy', err);
    }

    const webvhDid = asset.bindings?.['did:webvh'];
    if (webvhDid) {
      try {
        await this.hostCelLog(webvhDid, log);
      } catch (err) {
        await this.emitCelHostFailed(asset.id, 'webvh-cel-json', err);
      }
    }
  }

  /** cel:host-failed emitter that itself never throws (hosting is best-effort). */
  private async emitCelHostFailed(assetId: string, target: 'cel-copy' | 'webvh-cel-json', err: unknown): Promise<void> {
    try {
      await this.eventEmitter.emit({
        type: 'cel:host-failed',
        timestamp: new Date().toISOString(),
        asset: { id: assetId },
        target,
        error: err instanceof Error ? err.message : String(err)
      });
    } catch {
      // best-effort — a throwing emitter must not gate the lifecycle op
    }
  }

  private async publishResources(
    asset: OriginalsAsset,
    publisherDid: string,
    domain: string,
    userPath: string,
    writtenObjects?: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    // Publication must actually host content somewhere. Falling back to a
    // method-local MemoryStorageAdapter (whose contents are garbage-collected
    // the moment this call returns) — or writing nothing because the adapter
    // implements neither put() nor putObject() — would still migrate the
    // asset and issue a publication credential asserting content is hosted
    // when it is not (issue #244). The requirement applies only when there is
    // inline content to write: an asset whose resources are all hash-only
    // (content hosted elsewhere) performs no storage writes and remains
    // publishable without an adapter.
    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    const hasInlineContent = asset.resources.some(
      (r) => r.content !== undefined && r.content !== null
    );
    if (hasInlineContent) {
      if (!storage) {
        throw new StructuredError(
          'STORAGE_REQUIRED',
          'A storageAdapter must be configured to publish to web: resource content has to be hosted somewhere. ' +
          'Provide config.storageAdapter (e.g. MemoryStorageAdapter for tests, LocalStorageAdapter, or a custom adapter).'
        );
      }
      const storageWithPutCheck = storage as { put?: unknown; putObject?: unknown };
      if (typeof storageWithPutCheck.put !== 'function' && typeof storageWithPutCheck.putObject !== 'function') {
        throw new StructuredError(
          'STORAGE_REQUIRED',
          'The configured storageAdapter implements neither put() nor putObject(); resources cannot be published.'
        );
      }
    }

    for (const resource of asset.resources) {
      const hashBytes = hexToBytes(resource.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const resourceUrl = `${publisherDid}/resources/${multibase}`;
      // A canonical did:webvh with no user path (did:webvh:{SCID}:{domain})
      // yields an empty userPath; omit it so the storage key is
      // `${domain}/resources/...` rather than `${domain}//resources/...`.
      const relativePath = userPath
        ? `${userPath}/resources/${multibase}`
        : `resources/${multibase}`;

      // Hash-only resources (content hosted elsewhere) cannot be published:
      // writing the hash string as the body would serve bytes that fail the
      // resource's own integrity check. Skip them instead of corrupting.
      if (resource.content === undefined || resource.content === null) {
        this.logger.warn('Skipping publish of hash-only resource (no content available)', {
          resourceId: resource.id,
          hash: resource.hash
        });
        continue;
      }

      // Verify the bytes against the declared hash BEFORE writing anything or
      // attesting anything: the storage key, resource.url, resource:published
      // event and the ResourceMigrated credential all assert the declared
      // hash (issue #347).
      this.assertContentMatchesDeclaredHash(resource, 'publish');

      const data = Buffer.from(resource.content);

      const storageWithPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<void> };
      const storageWithPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<void> };

      if (typeof storageWithPut.put === 'function') {
        await storageWithPut.put(`${domain}/${relativePath}`, data, { contentType: resource.contentType });
        writtenObjects?.push({ domain, relativePath });
      } else if (typeof storageWithPutObject.putObject === 'function') {
        await storageWithPutObject.putObject(domain, relativePath, new TextEncoder().encode(resource.content));
        writtenObjects?.push({ domain, relativePath });
      }

      (resource as { url?: string }).url = resourceUrl;

      await this.emitResourcePublishedEvent(asset, resource, resourceUrl, publisherDid, domain);
    }
  }

  private async emitResourcePublishedEvent(
    asset: OriginalsAsset,
    resource: AssetResource,
    resourceUrl: string,
    publisherDid: string,
    domain: string
  ): Promise<void> {
    const event = {
      type: 'resource:published' as const,
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      resource: {
        id: resource.id,
        url: resourceUrl,
        contentType: resource.contentType,
        hash: resource.hash
      },
      publisherDid,
      domain
    };
    
    try {
      // Emit from both LifecycleManager and asset emitters
      await this.eventEmitter.emit(event);
      await (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
    } catch (err) {
      this.logger.error('Event handler error', err as Error, { event: event.type });
    }
  }

  private async issuePublicationCredential(
    asset: OriginalsAsset,
    migratedTo: string,
    signer?: ExternalSigner
  ): Promise<void> {
    try {
      if (!asset.resources.length || !asset.resources[0].id) {
        throw new StructuredError(
          'EMPTY_RESOURCE_LIST',
          'Cannot issue publication credential: asset has no resources'
        );
      }

      // The cross-layer claim is countersigned by the PREVIOUS layer's key:
      // issuer = the asset's peer DID (its key was registered in the keyStore
      // at createAsset). A publisher-self-asserted credential proves nothing
      // about the asset (#365).
      const subject = {
        id: asset.id,
        migratedTo,
        resourceId: asset.resources[0].id,
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
        migratedAt: new Date().toISOString()
      };

      const unsigned = this.credentialManager.createResourceCredential(
        'ResourceMigrated',
        subject,
        asset.id
      );

      let signed;
      try {
        signed = await this.signWithKeyStore(unsigned, asset.id);
      } catch (keyStoreErr) {
        if (signer) {
          // Fallback: external signer attests the publication when the peer
          // key is unavailable (issuer becomes the signer's DID — recorded
          // truthfully rather than pretending the peer key signed).
          const vmDid = signer.getVerificationMethodId().split('#')[0];
          const resigned = this.credentialManager.createResourceCredential('ResourceMigrated', subject, vmDid);
          signed = await this.credentialManager.signCredentialWithExternalSigner(resigned, signer);
        } else {
          throw keyStoreErr;
        }
      }

      asset.credentials.push(signed);
      
      const event = {
        type: 'credential:issued' as const,
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        credential: {
          type: signed.type,
          issuer: typeof signed.issuer === 'string' ? signed.issuer : signed.issuer.id
        }
      };
      
      // Emit from both LifecycleManager and asset emitters
      await this.eventEmitter.emit(event);
      await (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
    } catch (err) {
      // Non-fatal by design: publish succeeds without a publication
      // credential (e.g. keyStore-less setups). Surface the reason via a
      // credential:skipped event so callers can detect it programmatically
      // instead of only via logs.
      this.logger.error('Failed to issue credential during publish', err as Error);
      await this.eventEmitter.emit({
        type: 'credential:skipped',
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        reason: err instanceof StructuredError ? err.code : 'CREDENTIAL_ISSUANCE_FAILED',
        message: (err as Error)?.message ?? String(err)
      });
    }
  }

  private async signWithKeyStore(
    credential: VerifiableCredential,
    issuer: string
  ): Promise<VerifiableCredential> {
    if (!this.keyStore) {
      throw new StructuredError('KEYSTORE_REQUIRED', 'KeyStore required for signing. Provide keyStore to LifecycleManager constructor or use an external signer.');
    }

    // Resolve the issuer DID document up front so we can consult the retirement
    // status of each candidate verification method. After a key rotation or
    // compromise recovery, KeyManager stamps the OLD verification methods with
    // a `revoked`/`compromised` timestamp and appends the new active key LAST
    // (document = [...retiredVMs, newActiveVM]). Selecting a VM without
    // checking these fields would sign with a retired (possibly compromised)
    // key, breaking the integrity of the provenance chain.
    const didDoc = await this.didManager.resolveDID(issuer);
    const docVms = Array.isArray(didDoc?.verificationMethod) ? didDoc.verificationMethod : [];

    // Normalize a VM id to its absolute form so keyStore lookups and document
    // comparisons line up regardless of whether the document stored relative
    // (`#frag`) ids.
    const absoluteVmId = (id: string): string => (id.startsWith('#') ? `${issuer}${id}` : id);

    // A candidate VM is usable unless the DID document explicitly marks it as
    // retired. VM ids absent from the document (e.g. legacy keys only present
    // in the keyStore) are not disqualified — only an explicit
    // `revoked`/`compromised` timestamp retires a key.
    const isRetiredVmId = (id: string): boolean => {
      const abs = absoluteVmId(id);
      const entry = docVms.find(vm => absoluteVmId(vm.id) === abs);
      return !!entry && (!!entry.revoked || !!entry.compromised);
    };

    let privateKey: string | null = null;
    let vmId: string | null = null;

    const tryCandidate = async (candidateVmId: string): Promise<boolean> => {
      if (isRetiredVmId(candidateVmId)) {
        return false;
      }
      const key = await this.keyStore!.getPrivateKey(candidateVmId);
      if (key) {
        privateKey = key;
        vmId = candidateVmId;
        return true;
      }
      return false;
    };

    // First try common verification method patterns: #key-0, #keys-1, etc.
    const commonVmIds = [
      `${issuer}#key-0`,
      `${issuer}#keys-1`,
      `${issuer}#authentication`,
    ];

    for (const testVmId of commonVmIds) {
      if (await tryCandidate(testVmId)) {
        break;
      }
    }

    // If not found, try to find ANY active key that starts with the issuer DID
    const keyStoreWithGetAll = this.keyStore as { getAllVerificationMethodIds?: () => string[] };
    if (!privateKey && typeof keyStoreWithGetAll.getAllVerificationMethodIds === 'function') {
      const allVmIds = keyStoreWithGetAll.getAllVerificationMethodIds();
      for (const testVmId of allVmIds) {
        if (testVmId.startsWith(issuer) && (await tryCandidate(testVmId))) {
          break;
        }
      }
    }

    // If no key found in common patterns / keyStore scan, fall back to the DID
    // document. Select the first ACTIVE verification method (skipping retired
    // ones), never blindly verificationMethod[0].
    if (!privateKey) {
      if (docVms.length === 0) {
        throw new StructuredError('INVALID_DID_DOCUMENT', 'No verification method found in publisher DID document. Ensure the DID document includes at least one verificationMethod.');
      }

      const activeVm = docVms.find(vm => !vm.revoked && !vm.compromised);
      if (!activeVm) {
        throw new StructuredError('INVALID_DID_DOCUMENT', 'No active verification method found in publisher DID document. All verification methods have been revoked or marked compromised; rotate to a new key before signing.');
      }

      const candidateVmId = absoluteVmId(activeVm.id);
      const key = await this.keyStore.getPrivateKey(candidateVmId);
      if (!key) {
        throw new StructuredError('KEYSTORE_REQUIRED', 'Private key not found in keyStore. Register the key with lifecycle.registerKey() before signing.');
      }
      privateKey = key;
      vmId = candidateVmId;
    }

    if (!vmId) {
      throw new StructuredError('INVALID_DID_DOCUMENT', 'Verification method ID could not be determined from the DID document. Ensure the DID document contains a verificationMethod with an id field.');
    }

    return this.credentialManager.signCredential(credential, privateKey, vmId);
  }

  /**
   * Append-first lifecycle CEL event with the same degrade contract as
   * publishToWeb: signed by the CURRENT controller folded from the log; when
   * no keyStore / no CEL log / no signing key, skip and emit
   * `cel:append-skipped` instead of failing the lifecycle operation.
   *
   * @returns the head digest (chain-link expression over the appended entry —
   * stable across later witness-proof attachment, since chain canonicalization
   * excludes proofs) or null when the append was skipped.
   */
  private async appendCelEventOrSkip(
    asset: OriginalsAsset,
    type: 'migrate' | 'rotateKey' | 'transfer' | 'update',
    data: unknown
  ): Promise<string | null> {
    const logBefore = asset.celLog;
    let skipReason: 'NO_KEYSTORE' | 'NO_CEL_LOG' | 'NO_SIGNING_KEY' =
      !this.keyStore ? 'NO_KEYSTORE' : 'NO_CEL_LOG';
    if (this.keyStore && logBefore) {
      const vm = currentControllerVm(logBefore);
      if (await this.keyStore.getPrivateKey(vm)) {
        const signer = createKeyStoreCelSigner(this.keyStore, vm);
        const newLog = await appendEvent(logBefore, type, data, { signer, verificationMethod: vm });
        asset._replaceCelLog(newLog);
        // Keep the hosted CEL copies fresh AFTER the append committed.
        // Must never throw: transferOwnership converts any throw from this
        // method into CEL_APPEND_FAILED_POST_TRANSFER, which would misreport
        // a mere hosting failure as a truncated log.
        await this.persistCelArtifacts(asset);
        return computeDigestMultibase(canonicalizeEntryForChain(newLog.events[newLog.events.length - 1]));
      }
      skipReason = 'NO_SIGNING_KEY';
    }
    await this.eventEmitter.emit({
      type: 'cel:append-skipped',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      reason: skipReason
    });
    return null;
  }

  async inscribeOnBitcoin(
    asset: OriginalsAsset,
    feeRate?: number
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('inscribeOnBitcoin');
    const metricsStart = performance.now();
    this.logger.info('Inscribing asset on Bitcoin', { assetId: asset.id, feeRate });
    // Method-scoped so the outer catch can restore the pre-append log on any
    // failure after the append (in-memory only). Fires pre-broadcast (nothing
    // paid) AND post-broadcast — notably ORD_SATOSHI_UNKNOWN, where the
    // inscription already landed on-chain but anchors a now-rolled-back event;
    // that orphaned inscription is a harmless dangling anchor by design (see
    // Task-5 adjudication), so restoring the in-memory log is still correct.
    let celLogBefore: EventLog | undefined;
    let celHeadDigest: string | null = null;

    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new StructuredError('INVALID_INPUT', 'Invalid asset: must be a valid OriginalsAsset');
      }
      if (feeRate !== undefined) {
        if (typeof feeRate !== 'number' || feeRate <= 0 || !Number.isFinite(feeRate)) {
          throw new StructuredError('INVALID_INPUT', 'Invalid feeRate: must be a positive number');
        }
        if (feeRate < 1 || feeRate > 1000000) {
          throw new StructuredError('INVALID_INPUT', 'Invalid feeRate: must be between 1 and 1000000 sat/vB');
        }
      }

    if (typeof asset.migrate !== 'function') {
      throw new StructuredError('NOT_IMPLEMENTED', 'Asset inscription is not yet implemented for this asset type. Use a standard OriginalsAsset created via lifecycle.createAsset().');
    }
    if (asset.currentLayer !== 'did:webvh' && asset.currentLayer !== 'did:peer') {
      throw new StructuredError('NOT_IMPLEMENTED', 'Asset inscription is not yet implemented for this layer. Assets must be in did:peer or did:webvh layer to inscribe.');
    }
    // Concurrency guard (issue #255): the layer check above is check-then-act
    // across the awaits below — two overlapping calls would both pass it,
    // both broadcast paid commit/reveal pairs, and the loser's inscription
    // would be orphaned. Claim the asset synchronously before the first await.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An inscription or publication for asset ${asset.id} is already in progress; concurrent operations on the same asset would double-pay for duplicate inscriptions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    // The manifest permanently records each resource's declared hash on
    // Bitcoin; verify inline content against it first so a mismatched hash
    // is never inscribed (issue #347).
    for (const res of asset.resources) {
      this.assertContentMatchesDeclaredHash(res, 'inscribe on Bitcoin');
    }
    // Append-first (#365): the signed btco migrate event lands BEFORE the
    // inscription so the on-chain document can commit to the post-append head.
    // Satoshi/txid are unknown pre-inscription and are deliberately NOT in the
    // signed data — they arrive later via witness proofs (BtcoMigrationData).
    celLogBefore = asset.celLog;
    celHeadDigest = await this.appendCelEventOrSkip(asset, 'migrate', {
      sourceDid: asset.bindings?.['did:webvh'] ?? asset.id,
      layer: 'btco',
      network: this.getConfiguredBitcoinNetwork(),
      migratedAt: new Date().toISOString()
    });
    // Resource manifest rides INSIDE the DID document as a service entry —
    // the inscription itself must be the DID document (application/did+json)
    // or the SDK's own BtcoDidResolver rejects it (#375).
    const manifestEndpoint = {
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    const backLinks = [asset.id, asset.bindings?.['did:webvh']].filter(
      (d): d is string => typeof d === 'string'
    );

    // Held locally, not captured into the asset yet: buildContent runs BEFORE
    // the inscription is confirmed (satoshi known, asset.migrate succeeded).
    // Capturing here would leave a stale doc in #didDocuments with no rollback
    // if the operation fails afterward (e.g. ORD_SATOSHI_UNKNOWN) — mirrors
    // rotateBtcoKeys' post-success capture.
    let inscribedBtcoDoc: DIDDocument | undefined;
    const inscription = await bitcoinManager.inscribeData(
      async (satoshi: string) => {
        const btcoDoc = await this.didManager.migrateToDIDBTCO(asset.did, satoshi);
        btcoDoc.alsoKnownAs = backLinks;
        btcoDoc.service = [
          ...(btcoDoc.service || []),
          {
            id: `${btcoDoc.id}#resources`,
            type: 'OriginalsResourceManifest',
            serviceEndpoint: manifestEndpoint
          },
          // On-chain commitment to the entire signed history (#365): anchors
          // the CEL head so the log cannot be swapped or truncated post-hoc.
          // Absent when the append degraded — the doc simply lacks the anchor.
          ...(celHeadDigest !== null ? [{
            id: `${btcoDoc.id}#cel`,
            type: 'OriginalsCelAnchor',
            serviceEndpoint: { headDigestMultibase: celHeadDigest }
          }] : [])
        ];
        inscribedBtcoDoc = btcoDoc;
        return Buffer.from(JSON.stringify(btcoDoc));
      },
      'application/did+json',
      feeRate
    ) as {
      revealTxId?: string;
      txid: string;
      commitTxId?: string;
      inscriptionId: string;
      satoshi?: string;
      feeRate?: number;
      content?: Buffer;
    };
    const revealTxId = inscription.revealTxId ?? inscription.txid;
    const commitTxId = inscription.commitTxId;
    const usedFeeRate = typeof inscription.feeRate === 'number' ? inscription.feeRate : feeRate;

    // did:btco identity is satoshi-scoped. inscribeData now guarantees a
    // non-empty, validated satoshi (issue #256); check before migrating so a
    // missing satoshi cannot leave the asset half-migrated. An inscription id
    // is never a valid did:btco identifier, so there is no fallback.
    if (!inscription.satoshi) {
      throw new StructuredError(
        'ORD_SATOSHI_UNKNOWN',
        'Inscription completed but no satoshi was returned; cannot derive a did:btco binding.',
        { inscriptionId: inscription.inscriptionId, txid: revealTxId }
      );
    }

    // The DID-doc inscription IS the bitcoin witness artifact for the migrate
    // event appended above (#367): its #cel OriginalsCelAnchor commits to that
    // event's chain digest, so a bitcoin-ordinals-2024 witness proof binding
    // satoshi/inscriptionId makes the btco identity derivable — and GATING —
    // from the log alone (verifyEventLog checks the inscription against the
    // chain). No second inscription is made. Chain digests exclude proofs, so
    // this post-hoc attachment (mirroring witnessEvent) cannot break the chain
    // or the anchored head digest.
    if (celHeadDigest !== null && asset.celLog) {
      const log = asset.celLog;
      const migrateIdx = log.events.length - 1;
      const witnessedAt = new Date().toISOString();
      const witnessProof: WitnessProof & { txid: string; satoshi: string; inscriptionId: string } = {
        type: 'DataIntegrityProof',
        cryptosuite: 'bitcoin-ordinals-2024',
        created: witnessedAt,
        verificationMethod: 'did:btco:witness',
        proofPurpose: 'assertionMethod',
        proofValue: `z${inscription.inscriptionId}`,
        witnessedAt,
        txid: revealTxId,
        satoshi: inscription.satoshi,
        inscriptionId: inscription.inscriptionId
      };
      const events = log.events.slice();
      events[migrateIdx] = {
        ...events[migrateIdx],
        proof: [...events[migrateIdx].proof, witnessProof]
      };
      asset._replaceCelLog({ ...log, events });
    }

    // Capture the layer before migration for accurate metrics
    const fromLayer = asset.currentLayer;

    const migrationDetails = {
      transactionId: revealTxId,
      inscriptionId: inscription.inscriptionId,
      satoshi: inscription.satoshi,
      commitTxId,
      revealTxId,
      feeRate: usedFeeRate
    };
    await asset.migrate('did:btco', migrationDetails);

    // Retain the inscribed btco DID doc for serialize() (otherwise discarded)
    // — only now that the satoshi check and asset.migrate have both
    // succeeded, so a failure before this point (e.g. ORD_SATOSHI_UNKNOWN)
    // leaves #didDocuments untouched, consistent with the CEL-log restore.
    if (inscribedBtcoDoc) {
      asset._captureDidDocument('did:btco', inscribedBtcoDoc);
    }

    // Mirror onto the manager emitter: asset.migrate emits only on the
    // asset's private emitter, so sdk.lifecycle.on('asset:migrated', ...)
    // subscriptions (and the built-in EventLogger) never fired (issue #346).
    await this.eventEmitter.emit({
      type: 'asset:migrated',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id, fromLayer, toLayer: 'did:btco' },
      details: migrationDetails
    });

    // The binding is ALWAYS computed locally from the configured network +
    // the real satoshi the provider assigned — never the provider-echoed
    // document id. A compromised provider that echoes `{"id":"did:btco:…"}`
    // must not be able to steer the binding. Same network derivation as
    // migrateToDIDBTCO (explicit network wins over the webvhNetwork mapping,
    // #247), so a tier-only config can't drift into a prefix mismatch.
    const bindingValue = `${btcoDidPrefix(this.getConfiguredBitcoinNetwork())}:${inscription.satoshi}`;
    // Parse the echoed content ONLY as an integrity cross-check: if it parses
    // and disagrees with the computed binding, the provider may have altered
    // the inscription — log it (payment already happened, state is migrated;
    // do NOT throw, the caller has the inscriptionId to investigate). Missing
    // or non-JSON content is fine — no cross-check possible.
    if (inscription.content) {
      let inscribedDoc: { id?: unknown } | undefined;
      try {
        inscribedDoc = JSON.parse(inscription.content.toString()) as { id?: unknown };
      } catch {
        inscribedDoc = undefined;
      }
      if (inscribedDoc && inscribedDoc.id !== bindingValue) {
        this.logger.error(
          'Inscribed DID document id does not match expected binding — provider may have altered the inscription content',
          undefined,
          { expected: bindingValue, inscribed: inscribedDoc.id, inscriptionId: inscription.inscriptionId }
        );
      }
    }
    asset.bindings = Object.assign({}, asset.bindings || {}, { 'did:btco': bindingValue });

    // Witness acknowledgment (map §5.1): controller-signed update recording the
    // inscription that witnessed the btco migrate event. Appended AFTER the
    // witness-proof attach above; non-gating and best-effort (the inscription is
    // committed and paid). Also re-persists the now-proofed log through the
    // Task-3/4 choke point, closing the stored-copy-predates-the-proof window.
    if (celHeadDigest !== null && inscription.satoshi) {
      await this.appendWitnessAcknowledgment(asset, {
        satoshi: inscription.satoshi,
        inscriptionId: inscription.inscriptionId,
        txid: revealTxId,
        witnessedEventDigest: celHeadDigest
      });
    }

    stopTimer();
    this.logger.info('Asset inscribed on Bitcoin successfully', {
      assetId: asset.id, 
      inscriptionId: inscription.inscriptionId,
      transactionId: revealTxId
    });
    this.metrics.recordOperation('lifecycle.inscribeOnBitcoin', performance.now() - metricsStart, true);
    this.metrics.recordMigration(fromLayer, 'did:btco');

    return asset;
    } finally {
      this.inFlightAssets.delete(asset.id);
    }
    } catch (error) {
      // Anything thrown after the append leaves the log ahead of reality —
      // restore the pre-append snapshot (pure in-memory).
      if (celHeadDigest !== null && celLogBefore && asset.celLog !== celLogBefore) {
        asset._replaceCelLog(celLogBefore);
      }
      stopTimer();
      this.logger.error('Bitcoin inscription failed', error as Error, { assetId: asset.id, feeRate });
      this.metrics.recordOperation('lifecycle.inscribeOnBitcoin', performance.now() - metricsStart, false);
      this.metrics.recordError('INSCRIPTION_FAILED', 'inscribeOnBitcoin');
      throw error;
    }
  }

  async transferOwnership(
    asset: OriginalsAsset,
    newOwner: string
  ): Promise<BitcoinTransaction> {
    const stopTimer = this.logger.startTimer('transferOwnership');
    const metricsStart = performance.now();
    this.logger.info('Transferring asset ownership', { assetId: asset.id, newOwner });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new StructuredError('INVALID_INPUT', 'Invalid asset: must be a valid OriginalsAsset');
      }
      if (!newOwner || typeof newOwner !== 'string') {
        throw new StructuredError('INVALID_INPUT', 'Invalid newOwner: must be a non-empty string');
      }

      // Validate Bitcoin address format and checksum
      try {
        validateBitcoinAddress(newOwner, this.config.network);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
        throw new StructuredError('INVALID_ADDRESS', `Invalid Bitcoin address for ownership transfer: ${message}`);
      }

    // Transfer Bitcoin-anchored asset ownership
    // Only works for assets in did:btco layer
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Asset must be inscribed on Bitcoin before transfer. Migrate to did:btco first.');
    }
    // Concurrency guard (issue #255, same pattern as publishToWeb/
    // inscribeOnBitcoin): the checks above are check-then-act across the
    // awaits below — two overlapping transfers of the same asset would both
    // pass them and both broadcast paid transactions. Claim the asset
    // synchronously before the first await.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An operation for asset ${asset.id} is already in progress; concurrent transfers of the same asset would broadcast duplicate paid transactions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    const bm = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const provenance = asset.getProvenance();
    const latestMigration = provenance.migrations[provenance.migrations.length - 1];
    // Fall back to the satoshi encoded in the DID when no migration record is
    // present. A plain `split(':')[2]` is network-blind — for a regtest/signet
    // DID (`did:btco:reg:<sat>` / `did:btco:sig:<sat>`) index 2 is the network
    // tag, not the satoshi. parseSatoshiIdentifier handles every network prefix.
    let satoshi = latestMigration?.satoshi ?? '';
    if (!satoshi && asset.id.startsWith('did:btco:')) {
      try {
        satoshi = String(parseSatoshiIdentifier(asset.id));
      } catch {
        satoshi = '';
      }
    }
    // Determine the inscription that backs this transfer. When a migration
    // record exists we trust its inscription id; otherwise (e.g. an asset
    // rehydrated from a did:btco document, whose provenance starts empty) we
    // must resolve the REAL inscription on the satoshi via the provider rather
    // than fabricating `insc-<sat>` / `unknown-tx` placeholders — those write
    // invented backing-transaction data into provenance, and a real provider
    // rejects the transfer with a confusing "inscription not found".
    let inscriptionId = latestMigration?.inscriptionId;
    if (!inscriptionId) {
      if (!satoshi) {
        throw new StructuredError(
          'INSCRIPTION_NOT_FOUND',
          `Cannot transfer ${asset.id}: no migration record and no satoshi could be derived from the DID to locate its inscription.`
        );
      }
      inscriptionId = await bm.getInscriptionIdBySatoshi(satoshi) ?? undefined;
      if (!inscriptionId) {
        throw new StructuredError(
          'INSCRIPTION_NOT_FOUND',
          `Cannot transfer ${asset.id}: no inscription found on satoshi ${satoshi} to back the transfer.`
        );
      }
    }
    const inscription = {
      satoshi,
      inscriptionId,
      content: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      // Not used by transferInscription (which reads only inscriptionId); kept
      // for shape. Empty rather than a fabricated 'unknown-tx'.
      txid: latestMigration?.transactionId ?? '',
      vout: 0
    } as const;

    const tx = await bm.transferInscription(inscription, newOwner);
    // Record the actual chain of custody: the current owner (the last
    // transfer's recipient) hands off to newOwner. Recording the asset DID
    // as `from` on every transfer broke getTransfersFrom and produced a
    // provenance chain where nobody ever transferred to anybody.
    const priorTransfers = provenance.transfers;
    const currentOwner = priorTransfers.length > 0
      ? priorTransfers[priorTransfers.length - 1].to
      : asset.id;

    // Append-first CEL transfer event, signed by the OUTGOING controller, right
    // after the sat moved. Atomicity differs from publish/inscribe/rotate (task
    // 6): the sat has ALREADY moved, so a REAL append failure must NOT silently
    // degrade — provenance would truncate on-log with no signal. Ordering:
    //   try append → (catch) recordTransfer + throw CEL_APPEND_FAILED_POST_TRANSFER{txid}
    //   success/degrade → recordTransfer → emit asset:transferred (as today)
    // recordTransfer runs on BOTH paths so in-memory chain of custody is never
    // lost; the invariant is EITHER (log has transfer event + provenance
    // recorded) OR (provenance recorded + loud error carrying the txid to
    // re-append with). Guard-based degrade (no keyStore / no celLog / controller
    // key absent) still emits cel:append-skipped and falls through — that is the
    // never-had-it path, allowed here exactly as for the other ops.
    let celAppendError: unknown;
    try {
      await this.appendCelEventOrSkip(asset, 'transfer', {
        // Current controller's did:key (the DID part, pre-#) folded from the log.
        previousOwner: asset.celLog ? currentControllerVm(asset.celLog).split('#')[0] : undefined,
        newOwner,
        txid: tx.txid,
        transferredAt: new Date().toISOString()
      });
    } catch (appendErr) {
      celAppendError = appendErr;
    }

    // Rotation-first model (#366): the sat moved but the DID document still
    // carries the previous owner's keys. The recipient must rotateBtcoKeys.
    await asset.recordTransfer(currentOwner, newOwner, tx.txid, true);

    if (celAppendError) {
      const detail = celAppendError instanceof Error ? celAppendError.message : JSON.stringify(celAppendError);
      throw new StructuredError(
        'CEL_APPEND_FAILED_POST_TRANSFER',
        `Ownership transferred (txid ${tx.txid}) but the signed CEL transfer event could not be appended: ${detail}. Provenance is truncated on-log; re-append the transfer event with this txid.`,
        { txid: tx.txid }
      );
    }

    // Mirror onto the manager emitter: asset.recordTransfer emits only on the
    // asset's private emitter, so sdk.lifecycle.on('asset:transferred', ...)
    // subscriptions (and the built-in EventLogger) never fired (issue #346).
    // Payload must match the asset-emitted event exactly (keyRotationPending included).
    await this.eventEmitter.emit({
      type: 'asset:transferred',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id, layer: asset.currentLayer },
      from: currentOwner,
      to: newOwner,
      transactionId: tx.txid,
      keyRotationPending: true
    });

    stopTimer();
    this.logger.info('Asset ownership transferred successfully', {
      assetId: asset.id, 
      newOwner, 
      transactionId: tx.txid 
    });
    this.metrics.recordOperation('lifecycle.transferOwnership', performance.now() - metricsStart, true);
    this.metrics.recordTransfer();

    return tx;
    } finally {
      this.inFlightAssets.delete(asset.id);
    }
    } catch (error) {
      stopTimer();
      this.logger.error('Ownership transfer failed', error as Error, { assetId: asset.id, newOwner });
      this.metrics.recordOperation('lifecycle.transferOwnership', performance.now() - metricsStart, false);
      this.metrics.recordError('TRANSFER_FAILED', 'transferOwnership');
      throw error;
    }
  }

  // ===== Shared rotation-first core (rotateBtcoKeys + claimOwnership) =====

  /**
   * Ed25519 + derive check for a caller-supplied rotation keypair: the private
   * key MUST derive the announced `publicKeyMultibase`, or every subsequent
   * append would be signed by a key nobody can verify against. Pure — no
   * keyStore side effects. Throws CEL_ED25519_REQUIRED / INVALID_KEY_PAIR.
   */
  private assertRotationKeyPair(publicKeyMultibase: string, privateKey: string): void {
    const { key: privBytes, type: privType } = multikey.decodePrivateKey(privateKey);
    if (privType !== 'Ed25519') {
      throw new StructuredError('CEL_ED25519_REQUIRED',
        `CEL events must be signed with Ed25519; got ${privType}. Generate a dedicated Ed25519 controller key.`);
    }
    const derivedPub = multikey.encodePublicKey(ed25519.getPublicKey(privBytes), 'Ed25519');
    if (derivedPub !== publicKeyMultibase) {
      throw new StructuredError('INVALID_KEY_PAIR',
        'privateKey does not derive the announced publicKeyMultibase');
    }
  }

  /**
   * Builds the rotated did:btco document (shared by rotateBtcoKeys and
   * claimOwnership): same id, the NEW verification method, lineage back-links,
   * and the re-embedded resource manifest (the resolver serves the newest
   * inscription, so a rotation that dropped the manifest would erase it). The
   * `#cel` anchor is embedded separately, after the rotateKey head is known.
   * Throws NETWORK_MISMATCH if config.network drifted from the DID's prefix.
   */
  private buildRotatedBtcoDoc(
    asset: OriginalsAsset,
    satoshi: string,
    btcoDid: string,
    publicKeyMultibase: string
  ): DIDDocument {
    const { key, type } = multikey.decodePublicKey(publicKeyMultibase);
    const network = this.getConfiguredBitcoinNetwork();
    const rotatedDoc = createBtcoDidDocument(satoshi, network, { publicKey: key, keyType: type });
    // createBtcoDidDocument re-derives the prefix from network; the rotated id
    // MUST equal the existing binding or config.network drifted from the DID.
    if (rotatedDoc.id !== btcoDid) {
      throw new StructuredError('NETWORK_MISMATCH', `Rotated document id ${rotatedDoc.id} does not match binding ${btcoDid}; check config.network.`);
    }
    const backLinks = [asset.id, asset.bindings?.['did:webvh']].filter(
      (d): d is string => typeof d === 'string'
    );
    rotatedDoc.alsoKnownAs = backLinks;
    rotatedDoc.service = [
      ...(rotatedDoc.service || []),
      {
        id: `${rotatedDoc.id}#resources`,
        type: 'OriginalsResourceManifest',
        serviceEndpoint: {
          resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
          timestamp: new Date().toISOString()
        }
      }
    ];
    return rotatedDoc;
  }

  /**
   * Embeds the fresh `#cel` OriginalsCelAnchor (committing to the rotateKey
   * entry's chain digest) into the rotated document. The resolver serves the
   * newest inscription, so this must be re-embedded on every reinscription or
   * the anchor is erased.
   */
  private embedCelAnchor(rotatedDoc: DIDDocument, celHeadDigest: string): void {
    rotatedDoc.service = [
      ...(rotatedDoc.service || []),
      {
        id: `${rotatedDoc.id}#cel`,
        type: 'OriginalsCelAnchor',
        serviceEndpoint: { headDigestMultibase: celHeadDigest }
      }
    ];
  }

  /**
   * Reinscribes the rotated document on the SAME sat (targetSatoshi). On
   * failure — nothing is paid before the broadcast fails — restores the
   * pre-append CEL log (`restoreLog`) so the in-memory log never runs ahead of
   * the chain.
   */
  private async reinscribeRotatedDoc(
    asset: OriginalsAsset,
    rotatedDoc: DIDDocument,
    satoshi: string,
    feeRate: number | undefined,
    restoreLog: EventLog | undefined
  ): Promise<{ inscriptionId: string; satoshi?: string; txid?: string; revealTxId?: string }> {
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    try {
      return await bitcoinManager.inscribeData(
        Buffer.from(JSON.stringify(rotatedDoc)),
        'application/did+json',
        feeRate,
        { targetSatoshi: satoshi }
      );
    } catch (error) {
      // Reinscription failed after the append — restore the pre-append log
      // (pure in-memory; nothing was paid before broadcast failed).
      if (restoreLog) {
        asset._replaceCelLog(restoreLog);
      }
      throw error;
    }
  }

  /**
   * Attaches a `bitcoin-ordinals-2024` witness proof to the log's HEAD event
   * post-inscription (mirrors inscribeOnBitcoin): the reinscription commits to
   * the head's chain digest via its `#cel` anchor, so this proof binds
   * satoshi/inscriptionId/txid to that event. Chain digests exclude proofs, so
   * this post-hoc attachment cannot break the chain or the anchored head.
   */
  private attachBitcoinWitnessProof(
    asset: OriginalsAsset,
    witness: { satoshi: string; inscriptionId: string; txid: string }
  ): void {
    const log = asset.celLog;
    if (!log) return;
    const headIdx = log.events.length - 1;
    const witnessedAt = new Date().toISOString();
    const witnessProof: WitnessProof & { txid: string; satoshi: string; inscriptionId: string } = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bitcoin-ordinals-2024',
      created: witnessedAt,
      verificationMethod: 'did:btco:witness',
      proofPurpose: 'assertionMethod',
      proofValue: `z${witness.inscriptionId}`,
      witnessedAt,
      txid: witness.txid,
      satoshi: witness.satoshi,
      inscriptionId: witness.inscriptionId
    };
    const events = log.events.slice();
    events[headIdx] = {
      ...events[headIdx],
      proof: [...events[headIdx].proof, witnessProof]
    };
    asset._replaceCelLog({ ...log, events });
  }

  /**
   * Controller-signed witness acknowledgment (map §5.1): records the
   * inscription that witnessed `witnessedEventDigest` as an `update` event via
   * the STANDARD append path — folds to the CURRENT controller (for claim, the
   * NEW key post-rotation). Non-gating: `replayProvenance` ignores updates and
   * the verifier never requires it. Best-effort — the inscription is already
   * committed and paid, so a failed acknowledgment must not undo it. As a side
   * effect this append re-persists the now-proofed log through the Task-3/4
   * choke point, closing the window where the stored copy predates the proof.
   */
  private async appendWitnessAcknowledgment(
    asset: OriginalsAsset,
    ack: { satoshi: string; inscriptionId: string; txid?: string; witnessedEventDigest: string }
  ): Promise<void> {
    try {
      await this.appendCelEventOrSkip(asset, 'update', {
        operation: 'acknowledgeWitness',
        satoshi: ack.satoshi,
        inscriptionId: ack.inscriptionId,
        ...(ack.txid ? { txid: ack.txid } : {}),
        witnessedEventDigest: ack.witnessedEventDigest
      });
    } catch (err) {
      this.logger.warn('witness acknowledgment append failed (non-gating)', {
        assetId: asset.id,
        error: (err as Error)?.message ?? String(err)
      });
    }
  }

  /**
   * Rotation-first ownership hand-off (#366): reinscribe the did:btco
   * document — same id, new verification method — on the SAME sat. Only the
   * current UTXO holder can do this (reinscription spends the output), so a
   * successful rotation simultaneously proves sat control and announces the
   * new owner's signing key. The resolver's newest-valid-inscription rule
   * then serves the rotated document.
   *
   * KEY CUSTODY CONTRACT: after rotation the CURRENT controller folds to the
   * new key, so every subsequent CEL append (transfer, further rotation) signs
   * with it. The caller MUST make the new controller's PRIVATE key available in
   * the keyStore under the canonical VM id
   * `did:key:<publicKeyMultibase>#<publicKeyMultibase>`, or those appends degrade
   * (cel:append-skipped / NO_SIGNING_KEY). Pass it as `privateKey` here and, when
   * a keyStore is configured, it is registered under that VM id before the
   * rotateKey append. If omitted and the key is not already registered, a
   * `key:unpersisted` event (carrying the new VM) is emitted after the rotation
   * succeeds to surface the impending degrade.
   */
  async rotateBtcoKeys(
    asset: OriginalsAsset,
    newVerificationMethod: { publicKeyMultibase: string; privateKey?: string },
    feeRate?: number
  ): Promise<{ inscriptionId: string; did: string }> {
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Key rotation requires the asset to be on the did:btco layer.');
    }
    const btcoDid = asset.bindings?.['did:btco'];
    if (!btcoDid) {
      throw new StructuredError('INVALID_STATE', 'Asset has no did:btco binding to rotate.');
    }
    // Concurrency guard (issue #255, same pattern as publishToWeb/
    // transferOwnership): the checks above are check-then-act across the
    // awaits below — two overlapping rotations of the same asset would both
    // pass them and both broadcast reinscriptions. Claim the asset
    // synchronously before the first await.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An operation for asset ${asset.id} is already in progress; concurrent rotations of the same asset would broadcast duplicate reinscriptions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    // pop() yields the sat for every prefix form (did:btco:N, :reg:N, :sig:N).
    const satoshi = btcoDid.split(':').pop()!;
    // Shared rotated-doc build (backLinks + manifest + NETWORK_MISMATCH guard).
    const rotatedDoc = this.buildRotatedBtcoDoc(asset, satoshi, btcoDid, newVerificationMethod.publicKeyMultibase);

    // Append-first (#365): rotateKey signed by the CURRENT controller — the
    // cooperative-rotation contract (the verifier only accepts rotations
    // authorized by the outgoing authority). The non-cooperative arm (a NEW
    // owner who cannot obtain the seller's signature) is claimOwnership.
    // Canonical VM the post-rotation controller will sign appends under.
    const newController = `did:key:${newVerificationMethod.publicKeyMultibase}`;
    const newControllerVm = `${newController}#${newVerificationMethod.publicKeyMultibase}`;
    // Register the incoming controller's private key so post-rotation appends
    // can sign (key-custody contract). Before the append is fine — the rotateKey
    // event itself is signed by the OUTGOING controller; this key is for what
    // follows.
    if (newVerificationMethod.privateKey && this.keyStore) {
      this.assertRotationKeyPair(newVerificationMethod.publicKeyMultibase, newVerificationMethod.privateKey);
      await this.keyStore.setPrivateKey(newControllerVm, newVerificationMethod.privateKey);
    }

    const celLogBefore = asset.celLog;
    const celHeadDigest = await this.appendCelEventOrSkip(asset, 'rotateKey', {
      newController,
      rotatedAt: new Date().toISOString()
    });
    // Re-embed #cel with the FRESH head (the rotateKey entry). On degrade the
    // event was not appended and no anchor is embedded.
    if (celHeadDigest !== null) {
      this.embedCelAnchor(rotatedDoc, celHeadDigest);
    }

    const inscription = await this.reinscribeRotatedDoc(
      asset, rotatedDoc, satoshi, feeRate, celHeadDigest !== null ? celLogBefore : undefined
    );

    // Key-custody probe: no private key was supplied, and a keyStore exists but
    // doesn't hold the new controller's key. Post-rotation appends will degrade
    // (nothing was SKIPPED here — the rotation succeeded — so cel:append-skipped
    // is the wrong signal; key:unpersisted names the unpersisted VM).
    if (!newVerificationMethod.privateKey && this.keyStore &&
        !(await this.keyStore.getPrivateKey(newControllerVm))) {
      await this.eventEmitter.emit({
        type: 'key:unpersisted',
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        did: btcoDid,
        verificationMethod: newControllerVm
      });
    }

    // Reinscription succeeded — the rotated doc is now the resolvable btco doc;
    // it REPLACES the inscription-time capture for serialize().
    asset._captureDidDocument('did:btco', rotatedDoc);

    // Witness acknowledgment (map §5.1): controller-signed update recording the
    // reinscription. Folds to the CURRENT (post-rotation) controller; degrades
    // to a skip when that key isn't held. Only when the rotateKey landed.
    if (celHeadDigest !== null) {
      await this.appendWitnessAcknowledgment(asset, {
        satoshi,
        inscriptionId: inscription.inscriptionId,
        txid: inscription.revealTxId ?? inscription.txid,
        witnessedEventDigest: celHeadDigest
      });
    }

    await this.eventEmitter.emit({
      type: 'key:rotated',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      did: btcoDid,
      inscriptionId: inscription.inscriptionId
    });

    return { inscriptionId: inscription.inscriptionId, did: btcoDid };
    } finally {
      this.inFlightAssets.delete(asset.id);
    }
  }

  /**
   * Non-cooperative ownership claim (#366, design §5): the write side of the
   * verifier rule Task 5 landed. A NEW owner who has received the sat but
   * CANNOT obtain the seller's signature reinscribes the did:btco document —
   * same id, THEIR key — on the same sat, and self-signs the rotateKey with
   * that new key. Because only the current UTXO holder can reinscribe, the
   * reinscription is itself proof of sat control; the verifier accepts the
   * otherwise-unauthorized rotation once the attached bitcoin witness proof
   * (check (a)), the announced key (b), the signer (c), and the strictly-later
   * inscription index (d) all line up.
   *
   * Differs from {@link rotateBtcoKeys} (the COOPERATIVE arm): the rotateKey is
   * SELF-SIGNED with the new key (explicitly NOT the standard append path,
   * which folds to the seller's current controller the claimer does not hold),
   * `privateKey` is REQUIRED (the claimer must be able to sign), and a bitcoin
   * witness proof is attached to the rotateKey post-inscription — that is what
   * satisfies the verifier's check (a).
   *
   * @throws INVALID_STATE when the asset is not on did:btco / has no binding.
   * @throws INVALID_INPUT when no privateKey is supplied.
   * @throws INVALID_KEY_PAIR / CEL_ED25519_REQUIRED for a bad claimant keypair.
   * @throws OPERATION_IN_PROGRESS on a concurrent claim of the same asset.
   */
  async claimOwnership(
    asset: OriginalsAsset,
    newVerificationMethod: { publicKeyMultibase: string; privateKey: string },
    feeRate?: number
  ): Promise<{ inscriptionId: string; did: string }> {
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Claiming ownership requires the asset to be on the did:btco layer.');
    }
    const btcoDid = asset.bindings?.['did:btco'];
    if (!btcoDid) {
      throw new StructuredError('INVALID_STATE', 'Asset has no did:btco binding to claim.');
    }
    // privateKey is REQUIRED: the claimer self-signs the rotateKey with it (the
    // seller's controller is unavailable to fold onto).
    if (!newVerificationMethod?.privateKey) {
      throw new StructuredError('INVALID_INPUT', 'claimOwnership requires the claimant private key to self-sign the rotation.');
    }
    // Concurrency guard (issue #255, same pattern as rotateBtcoKeys): claim the
    // asset synchronously before the first await so two overlapping claims
    // cannot both broadcast reinscriptions.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An operation for asset ${asset.id} is already in progress; concurrent claims of the same asset would broadcast duplicate reinscriptions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    const satoshi = btcoDid.split(':').pop()!;
    const pkm = newVerificationMethod.publicKeyMultibase;
    // Derive-check the claimant keypair (privateKey REQUIRED); register it so
    // post-claim appends by the new controller can sign.
    this.assertRotationKeyPair(pkm, newVerificationMethod.privateKey);
    const newController = `did:key:${pkm}`;
    const newControllerVm = `${newController}#${pkm}`;

    // SELF-SIGN the rotateKey with the NEW key — explicitly NOT
    // appendCelEventOrSkip, which folds to the seller's current controller the
    // claimer cannot hold. The verifier accepts this unauthorized rotation
    // non-cooperatively once the reinscription witness proves sat control.
    const celLogBefore = asset.celLog;
    if (!celLogBefore) {
      throw new StructuredError('INVALID_STATE', 'Asset has no CEL log to append the claim rotation to.');
    }
    // Guard above must run BEFORE registering the key: a doomed claim (no CEL
    // log) should not leave an unused key sitting in the keyStore.
    if (this.keyStore) {
      await this.keyStore.setPrivateKey(newControllerVm, newVerificationMethod.privateKey);
    }

    // Shared rotated-doc build (backLinks + manifest + NETWORK_MISMATCH guard).
    const rotatedDoc = this.buildRotatedBtcoDoc(asset, satoshi, btcoDid, pkm);

    const { signer, verificationMethod } = celSignerFromKeyPair(
      { publicKey: pkm, privateKey: newVerificationMethod.privateKey }
    );
    const rotatedLog = await appendEvent(
      celLogBefore,
      'rotateKey',
      { newController, rotatedAt: new Date().toISOString() },
      { signer, verificationMethod }
    );
    asset._replaceCelLog(rotatedLog);
    const rotateEntry = rotatedLog.events[rotatedLog.events.length - 1];
    const celHeadDigest = computeDigestMultibase(canonicalizeEntryForChain(rotateEntry));

    // #cel anchor = the rotateKey event's chain digest (commits the on-chain
    // doc to the rotation the reinscription witnesses).
    this.embedCelAnchor(rotatedDoc, celHeadDigest);

    // Reinscribe on the SAME sat; restore the pre-append log on failure.
    const inscription = await this.reinscribeRotatedDoc(asset, rotatedDoc, satoshi, feeRate, celLogBefore);

    // Fail loudly rather than write an empty txid into the witness proof
    // (guaranteed verifier failure later): the reinscription already
    // happened and was paid for, so surface the inscriptionId for recovery.
    const witnessTxid = inscription.revealTxId ?? inscription.txid;
    if (!witnessTxid) {
      throw new StructuredError(
        'ORD_PROVIDER_INVALID_RESPONSE',
        'Reinscription succeeded but the provider returned neither revealTxId nor txid; cannot attach a witness proof.',
        { inscriptionId: inscription.inscriptionId }
      );
    }

    // Attach the bitcoin witness proof to the rotateKey event post-inscription
    // — this is what satisfies the verifier's non-cooperative check (a).
    this.attachBitcoinWitnessProof(asset, {
      satoshi,
      inscriptionId: inscription.inscriptionId,
      txid: witnessTxid
    });

    // Reinscription succeeded — the rotated doc is the resolvable btco doc.
    asset._captureDidDocument('did:btco', rotatedDoc);

    // Direct best-effort persist (issue: no-keyStore gap): with no keyStore,
    // appendWitnessAcknowledgment below degrades to a skip and never reaches
    // persistCelArtifacts, so the self-signed rotation + witness proof would
    // otherwise never reach storage. The ack's own persist (when it lands) is
    // a harmless double write.
    await this.persistCelArtifacts(asset);

    // Witness acknowledgment (map §5.1): the acknowledging controller IS the
    // new key (current post-rotation — the fold picks it up). This standard-path
    // append ALSO re-persists the now-proofed log through the Task-3/4 choke
    // point, closing the window where the stored copy predates the witness proof
    // attached above.
    await this.appendWitnessAcknowledgment(asset, {
      satoshi,
      inscriptionId: inscription.inscriptionId,
      txid: inscription.revealTxId ?? inscription.txid,
      witnessedEventDigest: celHeadDigest
    });

    await this.eventEmitter.emit({
      type: 'key:rotated',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      did: btcoDid,
      inscriptionId: inscription.inscriptionId
    });

    return { inscriptionId: inscription.inscriptionId, did: btcoDid };
    } finally {
      this.inFlightAssets.delete(asset.id);
    }
  }

  /**
   * The Bitcoin network this SDK is on, using the SAME derivation as
   * DIDManager.migrateToDIDBTCO (explicit `network` wins over the webvhNetwork
   * tier mapping, #247). Both the btco binding fallback and rotateBtcoKeys use
   * this so a tier-only config can never drift into a NETWORK_MISMATCH.
   */
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'regtest' | 'signet' {
    return this.config.network
      ?? (this.config.webvhNetwork ? getBitcoinNetworkForWebVH(this.config.webvhNetwork) : undefined)
      ?? 'mainnet';
  }

  /**
   * Create multiple assets in batch
   */
  async batchCreateAssets(
    resourcesList: AssetResource[][],
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchCreateAssets(resourcesList, options);
  }

  /**
   * Publish multiple assets to web storage in batch
   */
  async batchPublishToWeb(
    assets: OriginalsAsset[],
    domain: string,
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchPublishToWeb(assets, domain, options);
  }

  /**
   * Inscribe multiple assets on Bitcoin with cost optimization
   * KEY FEATURE: singleTransaction option for 30%+ cost savings
   */
  async batchInscribeOnBitcoin(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchInscribeOnBitcoin(assets, options);
  }

  /**
   * Transfer ownership of multiple assets in batch
   */
  async batchTransferOwnership(
    transfers: Array<{ asset: OriginalsAsset; to: string }>,
    options?: BatchOperationOptions
  ): Promise<BatchResult<BitcoinTransaction>> {
    return this.batchOps.batchTransferOwnership(transfers, options);
  }

  // ===== Clean Lifecycle API =====
  // These methods provide a cleaner, more intuitive API while maintaining
  // backward compatibility with the existing methods.

  /**
   * Create a draft asset (did:peer layer)
   * 
   * This is the entry point for creating new Originals. Draft assets are
   * stored locally and can be published or inscribed later.
   * 
   * @param resources - Array of resources to include in the asset
   * @param options - Optional configuration including progress callback
   * @returns The newly created OriginalsAsset in did:peer layer
   * 
   * @example
   * ```typescript
   * const draft = await sdk.lifecycle.createDraft([
   *   { id: 'main', type: 'code', contentType: 'text/javascript', hash: '...' }
   * ], {
   *   onProgress: (p) => console.log(p.message)
   * });
   * ```
   */
  async createDraft(
    resources: AssetResource[],
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing draft asset...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 20,
      message: 'Validating resources...'
    });
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 50,
        message: 'Creating DID document...'
      });
      
      const asset = await this.createAsset(resources);
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Draft asset created successfully'
      });
      
      return asset;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to create draft: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Publish an asset to the web (did:webvh layer)
   * 
   * Migrates a draft asset from did:peer to did:webvh, making it publicly
   * discoverable via HTTPS.
   * 
   * @param asset - The asset to publish (must be in did:peer layer)
   * @param publisherDidOrSigner - Publisher's DID or external signer
   * @param options - Optional configuration including progress callback
   * @returns The published OriginalsAsset in did:webvh layer
   * 
   * @example
   * ```typescript
   * const published = await sdk.lifecycle.publish(draft, 'did:webvh:example.com:user');
   * ```
   */
  async publish(
    asset: OriginalsAsset,
    publisherDidOrSigner: string | ExternalSigner,
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing to publish...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating migration...'
    });
    
    // Pre-flight validation
    const validation = this.validateMigration(asset, 'did:webvh');
    if (!validation.valid) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Validation failed: ${validation.errors.join(', ')}`
      });
      throw new StructuredError('MIGRATION_VALIDATION_FAILED', `Migration validation failed: ${validation.errors.join(', ')}`);
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Publishing resources...'
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 70,
        message: 'Finalizing publication...'
      });
      
      const published = await this.publishToWeb(asset, publisherDidOrSigner, options);
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Asset published successfully'
      });
      
      return published;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to publish: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Inscribe an asset on Bitcoin (did:btco layer)
   * 
   * Permanently anchors an asset on the Bitcoin blockchain via Ordinals inscription.
   * This is an irreversible operation.
   * 
   * @param asset - The asset to inscribe (must be in did:peer or did:webvh layer)
   * @param options - Optional configuration including fee rate and progress callback
   * @returns The inscribed OriginalsAsset in did:btco layer
   * 
   * @example
   * ```typescript
   * const inscribed = await sdk.lifecycle.inscribe(published, {
   *   feeRate: 15,
   *   onProgress: (p) => console.log(`${p.percentage}%: ${p.message}`)
   * });
   * ```
   */
  async inscribe(
    asset: OriginalsAsset,
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    const feeRate = options?.feeRate;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing inscription...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating migration...'
    });
    
    // Pre-flight validation
    const validation = this.validateMigration(asset, 'did:btco');
    if (!validation.valid) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Validation failed: ${validation.errors.join(', ')}`
      });
      throw new StructuredError('MIGRATION_VALIDATION_FAILED', `Migration validation failed: ${validation.errors.join(', ')}`);
    }
    
    // Show cost estimate
    if (onProgress) {
      const estimate = await this.estimateCost(asset, 'did:btco', feeRate);
      onProgress({
        phase: 'preparing',
        percentage: 20,
        message: `Estimated cost: ${estimate.totalSats} sats (${estimate.feeRate} sat/vB)`
      });
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Creating commit transaction...',
        details: { currentStep: 1, totalSteps: 3 }
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 60,
        message: 'Broadcasting reveal transaction...',
        details: { currentStep: 2, totalSteps: 3 }
      });
      
      const inscribed = await this.inscribeOnBitcoin(asset, feeRate);
      
      onProgress?.({
        phase: 'confirming',
        percentage: 90,
        message: 'Waiting for confirmation...',
        details: { currentStep: 3, totalSteps: 3 }
      });
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Asset inscribed successfully'
      });
      
      return inscribed;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to inscribe: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Transfer ownership of a Bitcoin-inscribed asset
   * 
   * Transfers an inscribed asset to a new owner. Only works for assets
   * in the did:btco layer.
   * 
   * @param asset - The asset to transfer (must be in did:btco layer)
   * @param newOwnerAddress - Bitcoin address of the new owner
   * @param options - Optional configuration including progress callback
   * @returns The Bitcoin transaction for the transfer
   * 
   * @example
   * ```typescript
   * const tx = await sdk.lifecycle.transfer(inscribed, 'bc1q...newowner');
   * console.log('Transfer txid:', tx.txid);
   * ```
   */
  async transfer(
    asset: OriginalsAsset,
    newOwnerAddress: string,
    options?: LifecycleOperationOptions
  ): Promise<BitcoinTransaction> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing transfer...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating transfer...'
    });
    
    // Validate asset is in correct layer
    if (asset.currentLayer !== 'did:btco') {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: 'Asset must be inscribed on Bitcoin before transfer'
      });
      throw new StructuredError('INVALID_STATE', 'Asset must be inscribed on Bitcoin before transfer. Migrate to did:btco first.');
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Creating transfer transaction...'
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 60,
        message: 'Broadcasting transaction...'
      });
      
      const tx = await this.transferOwnership(asset, newOwnerAddress);
      
      onProgress?.({
        phase: 'confirming',
        percentage: 90,
        message: 'Waiting for confirmation...',
        details: { transactionId: tx.txid }
      });
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Transfer complete',
        details: { transactionId: tx.txid }
      });
      
      return tx;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to transfer: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  // ===== Cost Estimation =====

  /**
   * Reject absurd estimator output on quote-only paths, mirroring
   * BitcoinManager's MAX_REASONABLE_FEE_RATE cap on spend paths: a compromised
   * fee oracle/provider must not be able to show users an arbitrary quote
   * (issue #351). Returning undefined lets the caller fall through to the
   * next fee source, matching BitcoinManager.resolveFeeRate's skip semantics.
   */
  private capEstimatedFeeRate(estimated: number): number | undefined {
    if (typeof estimated !== 'number' || !Number.isFinite(estimated) || estimated <= 0) {
      return undefined;
    }
    if (estimated > MAX_REASONABLE_FEE_RATE) {
      this.logger.warn('Ignoring absurd estimated fee rate for cost quote', {
        estimated,
        max: MAX_REASONABLE_FEE_RATE
      });
      return undefined;
    }
    return estimated;
  }

  /**
   * Estimate the cost of migrating an asset to a target layer
   * 
   * Returns a detailed breakdown of expected costs for Bitcoin operations.
   * For did:webvh migrations, costs are minimal (only hosting).
   * 
   * @param asset - The asset to estimate costs for
   * @param targetLayer - The target layer for migration
   * @param feeRate - Optional fee rate override (sat/vB)
   * @returns Detailed cost estimate
   * 
   * @example
   * ```typescript
   * const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco', 10);
   * console.log(`Estimated cost: ${cost.totalSats} sats`);
   * ```
   */
  async estimateCost(
    asset: OriginalsAsset,
    targetLayer: LayerType,
    feeRate?: number
  ): Promise<CostEstimate> {
    // For webvh, costs are minimal (just hosting costs not applicable here)
    if (targetLayer === 'did:webvh') {
      return {
        totalSats: 0,
        breakdown: {
          networkFee: 0,
          dataCost: 0,
          dustValue: 0
        },
        feeRate: 0,
        dataSize: 0,
        targetLayer,
        confidence: 'high'
      };
    }
    
    // For btco, calculate inscription costs
    if (targetLayer === 'did:btco') {
      // Calculate manifest size
      const manifest = {
        assetId: asset.id,
        resources: asset.resources.map(res => ({
          id: res.id,
          hash: res.hash,
          contentType: res.contentType,
          url: res.url
        })),
        timestamp: new Date().toISOString()
      };
      const dataSize = Buffer.from(JSON.stringify(manifest)).length;
      
      // Get fee rate from oracle or use provided/default
      let effectiveFeeRate = feeRate;
      let confidence: 'low' | 'medium' | 'high' = 'medium';
      
      if (!effectiveFeeRate) {
        // Try to get from fee oracle
        if (this.config.feeOracle) {
          try {
            effectiveFeeRate = this.capEstimatedFeeRate(await this.config.feeOracle.estimateFeeRate(1));
            confidence = 'high';
          } catch {
            // Fallback to default
          }
        }

        // Try ordinals provider
        if (!effectiveFeeRate && this.config.ordinalsProvider) {
          try {
            effectiveFeeRate = this.capEstimatedFeeRate(await this.config.ordinalsProvider.estimateFee(1));
            confidence = 'medium';
          } catch {
            // Fallback to default
          }
        }
        
        // Use default if no oracle available
        if (!effectiveFeeRate) {
          effectiveFeeRate = 10; // Conservative default
          confidence = 'low';
        }
      }
      
      // Transaction structure estimation:
      // - Commit transaction: ~200 vB base + input overhead
      // - Reveal transaction: ~200 vB base + inscription envelope + data
      // Inscription envelope overhead: ~122 bytes
      const commitTxSize = 200;
      const revealTxSize = 200 + 122 + dataSize;
      const totalSize = commitTxSize + revealTxSize;
      
      const networkFee = totalSize * effectiveFeeRate;
      const dustValue = 546; // Standard dust limit for P2TR
      const totalSats = networkFee + dustValue;
      
      return {
        totalSats,
        breakdown: {
          networkFee,
          dataCost: dataSize * effectiveFeeRate,
          dustValue
        },
        feeRate: effectiveFeeRate,
        dataSize,
        targetLayer,
        confidence
      };
    }
    
    // For peer layer (no migration needed)
    return {
      totalSats: 0,
      breakdown: {
        networkFee: 0,
        dataCost: 0,
        dustValue: 0
      },
      feeRate: 0,
      dataSize: 0,
      targetLayer,
      confidence: 'high'
    };
  }

  // ===== Migration Validation =====

  /**
   * Validate whether an asset can be migrated to a target layer
   *
   * Performs comprehensive pre-flight checks including:
   * - Valid layer transition
   * - Resource integrity
   * - Credential validity
   * - DID document structure
   * - Bitcoin readiness (for did:btco)
   *
   * @param asset - The asset to validate
   * @param targetLayer - The target layer for migration
   * @returns Detailed validation result
   *
   * @example
   * ```typescript
   * const validation = await sdk.lifecycle.validateMigration(draft, 'did:webvh');
   * if (!validation.valid) {
   *   console.error('Cannot migrate:', validation.errors);
   * }
   * ```
   */
  validateMigration(
    asset: OriginalsAsset,
    targetLayer: LayerType
  ): MigrationValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const checks = {
      layerTransition: false,
      resourcesValid: false,
      credentialsValid: false,
      didDocumentValid: false,
      bitcoinReadiness: undefined as boolean | undefined
    };
    
    // Check layer transition validity
    const validTransitions: Record<LayerType, LayerType[]> = {
      'did:peer': ['did:webvh', 'did:btco'],
      'did:webvh': ['did:btco'],
      'did:btco': []
    };
    
    if (validTransitions[asset.currentLayer].includes(targetLayer)) {
      checks.layerTransition = true;
    } else {
      errors.push(`Invalid migration from ${asset.currentLayer} to ${targetLayer}`);
    }
    
    // Validate resources
    if (asset.resources.length === 0) {
      errors.push('Asset must have at least one resource');
    } else {
      let resourcesValid = true;
      for (const resource of asset.resources) {
        if (!resource.id || !resource.type || !resource.contentType || !resource.hash) {
          resourcesValid = false;
          errors.push(`Resource ${resource.id || 'unknown'} is missing required fields`);
        }
        if (resource.hash && !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          resourcesValid = false;
          errors.push(`Resource ${resource.id} has invalid hash format`);
        }
      }
      checks.resourcesValid = resourcesValid;
    }
    
    // Validate DID document
    if (asset.did && asset.did.id) {
      checks.didDocumentValid = true;
    } else {
      errors.push('Asset has invalid or missing DID document');
    }
    
    // Validate credentials (structural check)
    if (asset.credentials.length > 0) {
      let credentialsValid = true;
      for (const cred of asset.credentials) {
        // VCDM 2.0 credentials carry validFrom; accept legacy issuanceDate too (#300).
        if (!cred.type || !cred.issuer || !(cred.validFrom || cred.issuanceDate)) {
          credentialsValid = false;
          warnings.push('Asset has credentials with missing fields');
        }
      }
      checks.credentialsValid = credentialsValid;
    } else {
      checks.credentialsValid = true; // No credentials is valid
    }
    
    // Bitcoin-specific checks
    if (targetLayer === 'did:btco') {
      checks.bitcoinReadiness = true;
      
      // Check if ordinals provider is configured
      if (!this.config.ordinalsProvider) {
        checks.bitcoinReadiness = false;
        errors.push('Bitcoin inscription requires an ordinalsProvider to be configured');
      }
      
      // Warn about large data sizes
      const manifestSize = JSON.stringify({
        assetId: asset.id,
        resources: asset.resources.map(r => ({
          id: r.id,
          hash: r.hash,
          contentType: r.contentType
        }))
      }).length;
      
      if (manifestSize > 100000) {
        warnings.push(`Large manifest size (${manifestSize} bytes) may result in high inscription costs`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      currentLayer: asset.currentLayer,
      targetLayer,
      checks
    };
  }
}


