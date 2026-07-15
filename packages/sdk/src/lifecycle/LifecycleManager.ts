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
import { hashResource, validateCredential } from '../utils/validation.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { parseSatoshiIdentifier, validateSatoshiNumber } from '../utils/satoshi-validation.js';
import { btcoDidPrefix, btcoDidFromSatoshi } from '../cel/btcoDid.js';
import { KeyManager } from '../did/KeyManager.js';
import { celSignerFromKeyPair, hexSha256ToDigestMultibase, createKeyStoreCelSigner, currentControllerVm } from '../cel/signerAdapter.js';
import { createCelDidDocument, didCelMatchesLog, deriveDidCel, DID_CEL_PREFIX } from '../cel/celDid.js';
import { verifyEventLog } from '../cel/algorithms/verifyEventLog.js';
import { createDidManagerKeyResolver } from '../cel/keyResolver.js';
import { PeerCelManager } from '../cel/layers/PeerCelManager.js';
import { appendEvent } from '../cel/algorithms/appendEvent.js';
import { computeDigestMultibase, digestMultibaseEquals, decodeDigestMultibase } from '../cel/hash.js';
import { mostRecentResourceHead } from '../cel/resourceHead.js';
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

  /**
   * #407 phase 3: chain digest of the newest CEL event already committed
   * on-chain for a btco asset (the snapshot head of the last inscription:
   * migrate / rotation / resource-update). A subsequent btco resource-update
   * inscribes only the DELTA of events appended since this head. Best-effort
   * optimization ONLY: when the boundary is unknown (empty map, digest not
   * found in the log), the append inscribes a FULL celLog snapshot instead —
   * correctness never depends on this map.
   */
  private lastInscribedHead = new WeakMap<OriginalsAsset, string>();

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

    // Bridge AssetResource hashes (hex sha256) to CEL ExternalReferences. The
    // resource id is bound into the genesis reference (#401) so the verifier can
    // require a resource's first `update` to chain from ITS OWN genesis digest,
    // not any genesis digest. (resource.id is validated as a non-empty string
    // above.)
    const externalRefs: ExternalReference[] = resources.map((r) => ({
      id: r.id,
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
    } else {
      // No keyStore: the freshly minted controller private key is held nowhere
      // and is dropped here, so the asset cannot author CEL events — publish/
      // inscribe/authorizeSigner appends will degrade (cel:append-skipped)
      // until this VM's key is available in a keyStore. Surface it; never
      // hard-fail (keyStore-less SDKs are valid for verification-only use).
      await this.eventEmitter.emit({
        type: 'key:unpersisted',
        timestamp: new Date().toISOString(),
        asset: { id: did },
        did,
        verificationMethod
      });
    }

    const asset = new OriginalsAsset(resources, didDoc, [], log);
    // Bind the controller append path so addResourceVersion can write signed
    // `update` events with the same degrade contract as the other authorship ops.
    asset._bindCelAppender((type, data) => this.appendCelEventAndMaybeInscribe(asset, type, data));

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
    // Each resource needs a string hash: the genesis-binding path feeds it to
    // hexSha256ToDigestMultibase, which throws a raw TypeError on undefined (#377).
    for (const res of env.resources) {
      if (!res || typeof res !== 'object' || typeof (res as { hash?: unknown }).hash !== 'string') {
        const resId = (res as { id?: unknown })?.id;
        throw new StructuredError('ENVELOPE_INVALID', `Envelope resource ${typeof resId === 'string' ? resId : '(unknown)'} is missing a string hash.`);
      }
    }
    // Credentials, when present, must be an array (else map() throws a raw
    // TypeError); their contents are validated after the fold (step 6).
    if (env.credentials !== undefined && !Array.isArray(env.credentials)) {
      throw new StructuredError('ENVELOPE_INVALID', 'Envelope credentials must be an array when present.');
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
    // Guard: replayProvenance throws a raw Error for a parseable-but-misordered
    // (non-create-first) log; surface it in the envelope taxonomy (#377).
    let folded: ReturnType<typeof replayProvenance>;
    try {
      folded = replayProvenance(log);
    } catch (e) {
      throw new StructuredError('ENVELOPE_INVALID', `Envelope eventLog cannot be folded into provenance: ${(e as Error).message}`);
    }

    // 3-5) Verification + binding + cross-checks (skipped by skipVerification).
    const provider = opts?.ordinalsProvider ?? this.config.ordinalsProvider;
    let verification: VerificationResult | undefined;
    if (!opts?.skipVerification) {
      verification = await verifyEventLog(log, {
        expectedDid: env.assetDid,
        resolveKey: createDidManagerKeyResolver(this.didManager),
        ordinalsProvider: provider,
        // A provider lets us reject a truncated pre-rotation log (#366); its
        // on-chain head betrays the omission. Off the ownership path — this is
        // an authorship-completeness check, not an ownership check.
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

      // 4b) Post-genesis resource binding (#401, generalized for #407). Genesis
      // (v1) resources are bound by checkGenesisResourceBinding + the step-4
      // content↔hash check above; every resource version ≥ 2 MUST instead be
      // backed by a VERIFIED `update` log event with the SAME resourceId and
      // version, and its blob content MUST hash to that event's SIGNED `toHash`.
      //
      // This is where CONTENT INTEGRITY now lives (#407): the verifier no longer
      // recomputes hash(content) — the bytes are not in the event — so the load
      // is the sole gate binding a content-addressed blob to the signed hash the
      // controller committed to. We bind blob→toHash DIRECTLY (not transitively
      // via the envelope-controlled res.hash): a forged blob (hash(content) ≠
      // toHash), a self-consistent forgery (content and res.hash both swapped),
      // and an unprovable degraded version (no backing event) all fail closed.
      for (const res of env.resources) {
        const version = typeof res.version === 'number' ? res.version : 1;
        if (version < 2) continue;
        const match = folded.resourceUpdates.find(
          u => u.resourceId === res.id && u.toVersion === version
        );
        if (!match) {
          throw new StructuredError(
            'ASSET_LOAD_VERIFICATION_FAILED',
            `Resource ${res.id} v${version} is not backed by a verified update event on the log (unprovable or forged post-genesis version).`,
            { verification }
          );
        }
        if (match.toHash.toLowerCase() !== String(res.hash).toLowerCase()) {
          throw new StructuredError(
            'ASSET_LOAD_VERIFICATION_FAILED',
            `Resource ${res.id} v${version}: envelope hash (${res.hash}) does not match the verified log's signed hash (${match.toHash}).`,
            { verification }
          );
        }
        // Bind the actual blob to the signed toHash. The content-addressed store
        // carries the bytes inline (AssetResource.content); a resource that omits
        // them is a pure reference and rides on the res.hash↔toHash match above.
        if (typeof res.content === 'string') {
          const computed = hashResource(Buffer.from(res.content, 'utf8'));
          if (computed.toLowerCase() !== match.toHash.toLowerCase()) {
            throw new StructuredError(
              'ASSET_LOAD_VERIFICATION_FAILED',
              `Resource ${res.id} v${version}: blob content hashes to ${computed}, not the log's signed toHash (${match.toHash}).`,
              { verification }
            );
          }
        }
      }

      // 4c) EVERY genesis (version-1) envelope resource must match the LOG's
      // genesis digest for its id EXACTLY (#407 — content integrity now lives at
      // load, so the binding must be total AND version-exact). checkGenesisResource
      // Binding above is subset-only (genesis ⊆ present) and step 4b keys off the
      // attacker-controlled `res.version`, so a resource labeled `version:1` would
      // otherwise skip 4b and be restored with zero backing. Version ≥ 2 resources
      // are bound by 4b to their EXACT `toVersion` update event, so they are left
      // to 4b here — binding v1 by mere hash-MEMBERSHIP (any update toHash for the
      // id) would let a genuine higher-version blob be relabeled to v1 and survive
      // (Greptile P1). Matching neither fails closed. Skipped only for legacy
      // (data.did) geneses with no resources array (they predate this contract).
      const genesisResources = (log.events[0]?.data as { resources?: unknown } | undefined)?.resources;
      if (Array.isArray(genesisResources)) {
        const genesisDigestById = new Map<string, string>();
        const genesisDigestsIdless = new Set<string>();
        for (const ref of genesisResources) {
          const dm = (ref as { digestMultibase?: unknown })?.digestMultibase;
          if (typeof dm !== 'string' || dm.length === 0) continue;
          const id = (ref as { id?: unknown })?.id;
          if (typeof id === 'string' && id.length > 0) genesisDigestById.set(id, dm);
          else genesisDigestsIdless.add(dm);
        }
        for (const res of env.resources) {
          const version = typeof res.version === 'number' ? res.version : 1;
          if (version >= 2) continue; // bound version-exactly by 4b above
          const resDigest = hexSha256ToDigestMultibase(String(res.hash));
          const boundGenesis = genesisDigestById.get(res.id);
          // id-bound genesis (#401): only THAT id's digest; id-less legacy genesis
          // falls back to matching any genesis digest.
          const matchesGenesis = boundGenesis !== undefined
            ? digestMultibaseEquals(resDigest, boundGenesis)
            : [...genesisDigestsIdless].some(d => digestMultibaseEquals(resDigest, d));
          if (!matchesGenesis) {
            throw new StructuredError(
              'ASSET_LOAD_VERIFICATION_FAILED',
              `Resource ${res.id} v${version} (hash ${res.hash}) is not declared by the log genesis; refusing to restore unbacked content.`,
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
    // pre-rotation authoring record would go undetected. Surface it — do not
    // fail. Off the ownership path: ownership is sat control, read live from
    // Bitcoin via getCurrentOwner(); this warns about provenance completeness.
    if (!provider && folded.currentLayer === 'did:btco') {
      warnings.push(
        'Loaded a btco-anchored asset without an ordinals provider: head freshness was NOT checked, so a ' +
        'truncated (pre-rotation) authoring record cannot be ruled out. Re-load with a provider to verify freshness.'
      );
    }
    // Missing head blob (#407): the log folds a resource head (latest toHash per
    // resourceId) that no envelope blob backs. Not a forgery — the signed hash
    // chain is intact and a substituted blob would fail 4c — but the buyer would
    // silently carry stale/absent content for the current version. Warn (like the
    // freshness gap), fetchable-by-hash from the content-addressed store later.
    if (!opts?.skipVerification) {
      const headByResource = new Map<string, string>();
      for (const u of folded.resourceUpdates) headByResource.set(u.resourceId, u.toHash);
      for (const [resourceId, headHash] of headByResource) {
        const backed = env.resources.some(
          r => r.id === resourceId && String(r.hash).toLowerCase() === headHash.toLowerCase()
        );
        if (!backed) {
          warnings.push(
            `Resource ${resourceId}: the log's current version (toHash ${headHash}) has no backing blob in the ` +
            `envelope; the loaded asset carries only an older version. Retrieve the current content by hash.`
          );
        }
      }
    }
    const provenance = this.buildRestoredProvenance(log, folded, env, warnings);

    // CRITICAL (#377): DERIVE the did:cel document from the VERIFIED genesis
    // controller — never trust envelope.didDocuments['did:cel']. A tampered VM
    // or rogue service in that doc would otherwise flow into the buyer's minted
    // did:webvh and inscribed did:btco identity. The rebuilt doc is a pure
    // function of the genesis, so re-serialization stays lossless.
    const genesisController = (log.events[0]?.data as { controller?: unknown })?.controller;
    if (typeof genesisController !== 'string' || !genesisController.startsWith('did:key:')) {
      throw new StructuredError(
        'ASSET_LOAD_VERIFICATION_FAILED',
        `Cannot derive did:cel document: genesis controller is not a did:key (got ${String(genesisController)}).`,
        { verification }
      );
    }
    const celDidDocument = createCelDidDocument(env.assetDid, genesisController.slice('did:key:'.length));

    // Important (#377): validate envelope credentials — a verified-reported load
    // must not silently attach forged/malformed ones. Structural validation runs
    // ALWAYS (even under skipVerification) and fails closed. Cryptographic
    // verification runs when not skipping, but a credential that does not verify
    // at load is SURFACED as a warning, not hard-failed: a genuine credential
    // issued by a since-rotated did:cel key legitimately no longer verifies
    // against the folded head (the resolver only knows the current key), and must
    // not block the buyer's load. Forged/unresolvable ones land here too — named,
    // never silently trusted. (Mirrors OriginalsAsset.verify's structural+crypto
    // credential path, downgrading only the crypto failure to advisory at load.)
    const credentials = (env.credentials ?? []).map(c => ({ ...c }));
    for (const cred of credentials) {
      if (!validateCredential(cred)) {
        throw new StructuredError(
          'ASSET_LOAD_VERIFICATION_FAILED',
          'Envelope carries a structurally invalid credential.',
          { verification }
        );
      }
    }
    if (!opts?.skipVerification) {
      for (const cred of credentials) {
        const credId = (cred as { id?: unknown }).id;
        const credLabel = typeof credId === 'string' ? credId : '(no id)';
        let ok = false;
        try {
          ok = await this.credentialManager.verifyCredential(cred);
        } catch {
          ok = false;
        }
        if (!ok) {
          warnings.push(
            `Credential ${credLabel} could not be cryptographically verified at load ` +
            `(forged, or issued by a since-rotated/unresolvable issuer); attached as unverified.`
          );
        }
      }
    }

    const asset = OriginalsAsset.restore(
      env.resources.map(r => ({ ...r })),
      celDidDocument,
      credentials,
      log,
      { currentLayer: folded.currentLayer, bindings: folded.bindings, provenance }
    );
    asset._bindCelAppender((type, data) => this.appendCelEventAndMaybeInscribe(asset, type, data));

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
   * Resolve + VERIFY a complete Originals asset from a bare satoshi — the #407
   * phase-2 chain-recovery path. Reads the NEWEST anchoring inscription on the
   * sat, reconstructs a byte-light {@link AssetEnvelope} from its metadata
   * (`{ didDocument, celLog }`) and content (the current media), and runs it
   * through {@link loadAsset} — so a chain-reconstructed asset verifies with the
   * SAME gate an envelope-loaded one does (verifyEventLog + resource binding +
   * head freshness + uniqueness + content-as-ordinal). Provenance is recoverable
   * from Bitcoin alone.
   *
   * Fail-closed: no provider, an invalid satoshi, no anchor inscription, an
   * unprovable-newest (missing block height) inscription, missing provenance
   * metadata, an embedded celLog head that disagrees with the on-chain `#cel`
   * anchor, or a failed loadAsset all throw. The reconstructed head media is
   * bound to the log's signed hash by loadAsset (a tampered media fails closed).
   *
   * @param satoshi - The bare satoshi number carrying the asset.
   * @param opts.ordinalsProvider - Defaults to `config.ordinalsProvider`.
   */
  async resolveAssetFromSat(
    satoshi: string,
    opts?: { ordinalsProvider?: OrdinalsLookup }
  ): Promise<{ asset: OriginalsAsset; verification?: VerificationResult; warnings: string[] }> {
    const provider = opts?.ordinalsProvider ?? this.config.ordinalsProvider;
    if (!provider) {
      throw new StructuredError('ORD_PROVIDER_REQUIRED', 'Ordinals provider must be configured to resolve an asset from a satoshi.');
    }
    const sat = String(satoshi);
    {
      const v = validateSatoshiNumber(sat);
      if (!v.valid) throw new StructuredError('INVALID_SATOSHI', `Invalid satoshi identifier: ${v.error}`);
    }

    // 1) Enumerate the sat's inscription chain (#407 phase 3). Each btco
    // authorship append adds one inscription; walking them in confirmed-block
    // order reconstructs the ALWAYS-CURRENT log — not just phase-2's point-in-time
    // newest snapshot.
    if (typeof provider.getInscriptionsBySatoshi !== 'function') {
      throw new StructuredError('ORD_PROVIDER_REQUIRED', `The ordinals provider cannot enumerate inscriptions on satoshi ${sat}.`);
    }
    let onSat: Array<{ inscriptionId: string }>;
    try {
      onSat = await provider.getInscriptionsBySatoshi(sat);
    } catch (e) {
      throw new StructuredError('CHAIN_ASSET_NOT_FOUND', `Failed to enumerate inscriptions on satoshi ${sat}: ${e instanceof Error ? e.message : String(e)}.`);
    }

    // 2) Fetch each, keeping OUR anchoring inscriptions (metadata carries a
    // didDocument AND either a full celLog snapshot or an events delta). Order
    // strictly by confirmed block height (list index as the documented
    // same-block residual). A missing block height on any anchoring inscription
    // fails closed — the chain order would be unprovable.
    type Link = {
      inscriptionId: string;
      listIdx: number;
      blockHeight: number;
      didDocument: unknown;
      snapshotEvents?: unknown[]; // full celLog (checkpoint) → REPLACE
      deltaEvents?: unknown[];    // events delta → APPEND
      content?: Buffer;
      txid?: string;
    };
    const links: Link[] = [];
    for (let idx = 0; idx < onSat.length; idx++) {
      const inscriptionId = onSat[idx].inscriptionId;
      let insc: Awaited<ReturnType<OrdinalsLookup['getInscriptionById']>>;
      try {
        insc = await provider.getInscriptionById(inscriptionId);
      } catch (e) {
        // A metadata-undecodable error (or any fetch failure) fails closed: a
        // provider that cannot read an inscription must not yield a silent
        // partial reconstruction.
        throw new StructuredError('CHAIN_ASSET_INVALID', `Failed to fetch inscription ${inscriptionId} on satoshi ${sat}: ${e instanceof Error ? e.message : String(e)}.`);
      }
      if (!insc) continue;
      const meta = insc.metadata as { didDocument?: unknown; celLog?: unknown; events?: unknown } | undefined;
      if (!meta || !meta.didDocument || typeof meta.didDocument !== 'object') continue;
      const snapshot = meta.celLog !== undefined && meta.celLog !== null
        ? (meta.celLog as { events?: unknown }).events
        : undefined;
      const delta = Array.isArray(meta.events) ? meta.events : undefined;
      if (snapshot === undefined && delta === undefined) continue; // not an anchoring inscription
      const rawHeight = (insc as { blockHeight?: unknown }).blockHeight;
      const height = typeof rawHeight === 'number' && Number.isInteger(rawHeight) && rawHeight >= 0 ? rawHeight : undefined;
      if (height === undefined) {
        throw new StructuredError('CHAIN_ASSET_INVALID', `Anchoring inscription ${inscriptionId} on satoshi ${sat} has no confirmed block height; the chain order is unprovable.`);
      }
      links.push({
        inscriptionId,
        listIdx: idx,
        blockHeight: height,
        didDocument: meta.didDocument,
        ...(Array.isArray(snapshot) ? { snapshotEvents: snapshot } : {}),
        ...(delta ? { deltaEvents: delta } : {}),
        ...(insc.content !== undefined ? { content: insc.content } : {}),
        ...(typeof insc.txid === 'string' ? { txid: insc.txid } : {})
      });
    }
    if (links.length === 0) {
      throw new StructuredError('CHAIN_ASSET_NOT_FOUND', `No Originals anchoring inscription found on satoshi ${sat}.`);
    }
    links.sort((a, b) => a.blockHeight - b.blockHeight || a.listIdx - b.listIdx);

    // 3) Walk oldest→newest, concatenating events: a full celLog snapshot is a
    // checkpoint (REPLACE); an events delta extends (APPEND). The result is the
    // full current log; verifyEventLog (below, via loadAsset) enforces contiguous
    // hash-chain continuity, so any gap or mis-ordered same-block link fails
    // closed there — the resolver never trusts the concatenation blindly.
    let rawEvents: unknown[] = [];
    for (const link of links) {
      if (link.snapshotEvents) {
        rawEvents = link.snapshotEvents.slice();
      } else if (link.deltaEvents) {
        rawEvents = rawEvents.concat(link.deltaEvents);
      }
    }
    const newest = links[links.length - 1];
    const btcoDoc = newest.didDocument;

    let log: EventLog;
    try {
      log = parseEventLogJson(JSON.stringify({ events: rawEvents }));
    } catch (e) {
      throw new StructuredError('CHAIN_ASSET_INVALID', `Reconstructed log from satoshi ${sat} is not a valid CEL log: ${(e as Error).message}`);
    }
    if (!Array.isArray(log.events) || log.events.length === 0) {
      throw new StructuredError('CHAIN_ASSET_INVALID', `Reconstructed log from satoshi ${sat} has no events.`);
    }

    // 4) The newest inscription's `#cel` anchor MUST equal the reconstructed log
    // head (else the newest link is inconsistent with the concatenated chain).
    const anchorDigest = this.extractCelAnchorFromDoc(btcoDoc);
    const headDigest = computeDigestMultibase(canonicalizeEntryForChain(log.events[log.events.length - 1]));
    if (anchorDigest === undefined) {
      throw new StructuredError('CHAIN_ASSET_INVALID', `Newest inscription ${newest.inscriptionId} DID document carries no OriginalsCelAnchor; cannot confirm the reconstructed log head.`);
    }
    if (!digestMultibaseEquals(anchorDigest, headDigest)) {
      throw new StructuredError('CHAIN_ASSET_INVALID', `Newest inscription ${newest.inscriptionId}: reconstructed log head (${headDigest}) does not equal its #cel anchor (${anchorDigest}); the chain is truncated or inconsistent.`);
    }

    // 5) Reconstruct the byte-light AssetEnvelope. The head event needs its OWN
    // bitcoin witness proof reattached — the writer inscribes the doc/log BEFORE
    // the inscription id exists, so the head's witness (which names the newest
    // inscription) is never in the embedded snapshot/delta. It is fully
    // re-verified against the chain by verifyBitcoinWitnessProof inside loadAsset.
    const headTxid = typeof newest.txid === 'string' ? newest.txid : undefined;
    const headWitness: WitnessProof & { txid?: string; satoshi: string; inscriptionId: string } = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bitcoin-ordinals-2024',
      created: new Date().toISOString(),
      verificationMethod: 'did:btco:witness',
      proofPurpose: 'assertionMethod',
      proofValue: `z${newest.inscriptionId}`,
      witnessedAt: new Date().toISOString(),
      txid: headTxid,
      satoshi: sat,
      inscriptionId: newest.inscriptionId
    };
    const headIdx = log.events.length - 1;
    const events = log.events.slice();
    events[headIdx] = { ...events[headIdx], proof: [...events[headIdx].proof, headWitness] };
    const reconstructedLog: EventLog = { ...log, events };

    // Current media = the newest inscription content that hashes to the log's
    // most-recent-resource head (a rotation's newest inscription carries no new
    // media, so the media may live in an earlier resource-update inscription).
    const head = mostRecentResourceHead(reconstructedLog);
    let headContent: Buffer | undefined;
    if (head) {
      for (let i = links.length - 1; i >= 0; i--) {
        const c = links[i].content;
        if (c && hashResource(Buffer.from(c.toString('utf8'), 'utf8')).toLowerCase() === head.hash.toLowerCase()) {
          headContent = c;
          break;
        }
      }
    }
    const resources = this.reconstructResourcesFromLog(reconstructedLog, headContent);

    // did:cel document is DERIVED (loadAsset re-derives it anyway; supply a
    // structurally valid one). did:btco is the on-chain metadata doc.
    const assetDid = deriveDidCel(reconstructedLog);
    const genesisController = (reconstructedLog.events[0]?.data as { controller?: unknown })?.controller;
    if (typeof genesisController !== 'string' || !genesisController.startsWith('did:key:')) {
      throw new StructuredError('CHAIN_ASSET_INVALID', `Reconstructed genesis controller is not a did:key (only did:key controllers are supported by resolveAssetFromSat; got: ${String(genesisController)}).`);
    }
    const celDoc = createCelDidDocument(assetDid, genesisController.slice('did:key:'.length));

    const envelope: AssetEnvelope = {
      format: ASSET_ENVELOPE_FORMAT,
      version: ASSET_ENVELOPE_VERSION,
      assetDid,
      eventLog: reconstructedLog,
      didDocuments: {
        'did:cel': celDoc,
        'did:btco': btcoDoc as DIDDocument
      },
      resources
    };

    // 6) loadAsset runs the full verification gate (incl. content-as-ordinal via
    // the head blob's hash binding). checkHeadFreshness is engaged by the
    // provider passthrough.
    return this.loadAsset(envelope, { ordinalsProvider: provider });
  }

  /** Extracts the first OriginalsCelAnchor headDigestMultibase from a DID doc. */
  private extractCelAnchorFromDoc(doc: unknown): string | undefined {
    const services = (doc as { service?: unknown })?.service;
    if (!Array.isArray(services)) return undefined;
    for (const entry of services) {
      const svc = entry as { type?: unknown; serviceEndpoint?: unknown };
      if (svc?.type !== 'OriginalsCelAnchor') continue;
      const head = (svc.serviceEndpoint as { headDigestMultibase?: unknown } | undefined)?.headDigestMultibase;
      if (typeof head === 'string' && head.length > 0) return head;
    }
    return undefined;
  }

  /**
   * Rebuild the byte-light resources array from a CEL log (#407 phase 2
   * chain-recovery): every genesis resource (v1) + every resource-shaped update
   * (v≥2), matched to the shapes loadAsset's genesis/version binding expects.
   * Only the head resource gets inline content (the on-chain media), and only
   * when it hashes to the log's most-recent-resource hash — so loadAsset's
   * blob↔toHash gate (which independently re-checks it) passes; a
   * non-utf8-roundtrippable or mismatched blob is left as a pure reference.
   */
  private reconstructResourcesFromLog(log: EventLog, headContent: Buffer | undefined): AssetResource[] {
    const resources: AssetResource[] = [];
    const genesis = log.events[0]?.data as { resources?: unknown } | undefined;
    const gres: Array<Record<string, unknown>> = Array.isArray(genesis?.resources) ? genesis.resources : [];
    for (const ref of gres) {
      const dm = ref.digestMultibase;
      if (typeof dm !== 'string') continue;
      let hash: string;
      try { hash = Buffer.from(decodeDigestMultibase(dm)).toString('hex'); } catch { continue; }
      const url = Array.isArray(ref.url) && typeof ref.url[0] === 'string' ? ref.url[0] : undefined;
      resources.push({
        id: typeof ref.id === 'string' ? ref.id : '',
        type: 'data',
        contentType: typeof ref.mediaType === 'string' ? ref.mediaType : 'application/octet-stream',
        hash,
        version: 1,
        ...(url ? { url } : {})
      });
    }
    for (let i = 1; i < log.events.length; i++) {
      const ev = log.events[i];
      if (ev.type !== 'update') continue;
      const d = (ev.data ?? {}) as Record<string, unknown>;
      const resourceId = typeof d.resourceId === 'string' ? d.resourceId : undefined;
      const previousVersionHash = typeof d.previousVersionHash === 'string' ? d.previousVersionHash : undefined;
      const toHash = typeof d.toHash === 'string' && d.toHash.length > 0 ? d.toHash : undefined;
      if (!resourceId || !previousVersionHash || !toHash) continue;
      resources.push({
        id: resourceId,
        type: 'data',
        contentType: typeof d.contentType === 'string' ? d.contentType : 'application/octet-stream',
        hash: toHash,
        ...(typeof d.toVersion === 'number' ? { version: d.toVersion } : {}),
        previousVersionHash
      });
    }
    // Attach the on-chain media to the head resource, iff it round-trips to the
    // head hash (loadAsset re-verifies hash(content) == signed toHash).
    const head = mostRecentResourceHead(log);
    if (headContent && head) {
      const contentStr = headContent.toString('utf8');
      if (hashResource(Buffer.from(contentStr, 'utf8')).toLowerCase() === head.hash.toLowerCase()) {
        const target = resources.find(r => (!head.resourceId || r.id === head.resourceId) && r.hash === head.hash && r.content === undefined);
        if (target) target.content = contentStr;
      }
    }
    return resources;
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
   * Live ownership of the asset's anchoring satoshi, read from Bitcoin.
   * Ownership IS sat control; the CEL is authorship only. A convenience LIVE
   * READ, not an integrity gate (that's verify()/loadAsset's job), so it
   * fails open: returns null for assets not yet on did:btco, for a
   * malformed/unresolvable did:btco binding, or when the provider has no
   * owner index. Throws ORD_PROVIDER_REQUIRED only when no ordinalsProvider
   * is configured.
   */
  async getCurrentOwner(asset: OriginalsAsset): Promise<{ address: string; outpoint: string } | null> {
    const btcoDid = asset.bindings?.['did:btco'] ?? (asset.id.startsWith('did:btco:') ? asset.id : undefined);
    if (!btcoDid) return null;
    const provider = this.config.ordinalsProvider;
    if (!provider) {
      throw new StructuredError('ORD_PROVIDER_REQUIRED', 'Ordinals provider must be configured to read live ownership from Bitcoin.');
    }
    let satoshi: string;
    try {
      satoshi = String(parseSatoshiIdentifier(btcoDid));
    } catch {
      return null;
    }
    if (typeof provider.getSatOwnership !== 'function') return null;
    try {
      return await provider.getSatOwnership(satoshi);
    } catch (err) {
      this.logger.warn('getCurrentOwner: ordinals provider getSatOwnership failed; returning null', {
        satoshi,
        error: (err as Error)?.message ?? String(err)
      });
      return null;
    }
  }

  /**
   * Fold the log into a {@link ProvenanceChain} for restore(). createdAt/creator
   * come from the genesis data; migrations are re-materialized in the live
   * layer-to-layer shape (enriched from bitcoin witness proofs + advisory
   * `unverified.commitTxId`/`feeRate`); ownership history is the sat's UTXO
   * chain, not the CEL, so provenance carries no transfers. The
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
    // A genesis without a string createdAt is malformed — reject rather than
    // fold an empty timestamp into provenance (new Date('') = Invalid Date).
    if (typeof genesisData.createdAt !== 'string' || genesisData.createdAt.length === 0) {
      throw new StructuredError(
        'ENVELOPE_INVALID',
        'Envelope event log genesis is missing a string data.createdAt; cannot restore provenance.'
      );
    }
    const createdAt = genesisData.createdAt;
    const creator = typeof genesisData.controller === 'string'
      ? genesisData.controller
      : typeof genesisData.creator === 'string'
        ? genesisData.creator
        : env.assetDid;

    // Re-materialize migrations layer-to-layer by walking the log. Genesis is a
    // did:cel (the derived genesis identity), so the first migration folds from it.
    const migrations: ProvenanceChain['migrations'] = [];
    let layer: LayerType = 'did:cel';
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
        // The anchoring sat is the SIGNED data.to (design 2026-07-13). txid /
        // inscriptionId stay advisory transaction metadata scraped off the
        // (unsigned) witness — they are not identity-bearing.
        let satoshi: string | undefined;
        if (typeof data.to === 'string') {
          try { satoshi = String(parseSatoshiIdentifier(data.to)); } catch { satoshi = undefined; }
        }
        migrations.push({
          from: layer,
          to: 'did:btco',
          timestamp,
          transactionId: wp?.txid,
          inscriptionId: wp?.inscriptionId,
          satoshi,
          commitTxId: env.unverified?.commitTxId,
          revealTxId: wp?.txid,
          feeRate: env.unverified?.feeRate
        });
        layer = 'did:btco';
      }
    }

    // Resource versions are now signed `update` log events — fold them from the
    // (verified) log, never from the advisory envelope section (removed).
    const resourceUpdates = folded.resourceUpdates.map(u => ({ ...u }));

    // txid: the btco migration's witnessed reveal txid (ownership moves live on
    // the sat's UTXO chain, not the CEL — no transfers to derive a txid from).
    const lastBtco = [...migrations].reverse().find(m => m.to === 'did:btco');
    const txid = lastBtco?.transactionId;

    // 7) Degraded binding: fold couldn't derive btco but the honesty section
    // carries one — do NOT promote; surface as advisory.
    const advisoryBtco = env.unverified?.bindings?.['did:btco'];
    if (!folded.bindings['did:btco'] && advisoryBtco) {
      warnings.push(
        `did:btco binding (${advisoryBtco}) is present only in unverified.bindings and is not derivable from the log; ` +
        `it was NOT promoted to a trusted binding (advisory only).`
      );
    }

    const provenance: ProvenanceChain = { createdAt, creator, migrations, resourceUpdates };
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
      assetId: `did:cel:placeholder`,
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
      if (asset.currentLayer !== 'did:cel') {
        throw new StructuredError('INVALID_STATE', 'Asset must be in the genesis layer (did:cel) to publish to web.');
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

      // Capture the layer before migration (the genesis layer — 'did:cel' —
      // per the guard above; captured dynamically).
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
      this.metrics.recordMigration(priorLayer, 'did:webvh');

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
        // did:cel is the sole genesis layer (did:peer purged, Phase 4 · 5/5);
        // this now matches the asset:migrated event / getProvenance().from.
        // Deeper credential-derivation reconciliation remains #405.
        fromLayer: 'did:cel' as const,
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
    type: 'migrate' | 'rotateKey' | 'update',
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

  /**
   * Controller-append entry point BOUND to `addResourceVersion` (#407 phase 3).
   * First runs the standard hosted append (`appendCelEventOrSkip`); then, for a
   * did:btco asset whose append LANDED, inscribes the new event on the anchoring
   * sat so the on-chain log is always current (real-time recoverability). The
   * witness-ack path calls `appendCelEventOrSkip` DIRECTLY (not this), so acks do
   * NOT trigger a nested inscription. Migrate/rotation inscribe on their own
   * paths, so only genuine post-btco authorship appends (resource updates) reach
   * the inscribe branch here.
   *
   * Degrade (spec §1): off-btco, a degraded append (digest null), or no ordinals
   * provider → hosted append only, with a clear `cel:append-inscribe-skipped`
   * signal in the provider-absent case (never silent).
   */
  private async appendCelEventAndMaybeInscribe(
    asset: OriginalsAsset,
    type: 'migrate' | 'rotateKey' | 'update',
    data: unknown
  ): Promise<string | null> {
    const digest = await this.appendCelEventOrSkip(asset, type, data);
    // Only inscribe genuine authorship appends that LANDED on a btco asset.
    if (digest === null || asset.currentLayer !== 'did:btco') {
      return digest;
    }
    const provider = this.config.ordinalsProvider ?? this.deps?.bitcoinManager?.ordinalsProvider;
    if (!provider) {
      // Spec §1: provider-absent → hosted append (degrade), not a crash. Surface
      // it clearly so callers know the on-chain log did NOT advance this append.
      await this.eventEmitter.emit({
        type: 'cel:append-inscribe-skipped',
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        reason: 'NO_ORDINALS_PROVIDER'
      });
      return digest;
    }
    await this.inscribeCelAppend(asset, digest);
    return digest;
  }

  /**
   * Inscribe a just-appended btco authorship event on the anchoring sat (#407
   * phase 3). Content = the new head media (or DID-doc fallback for a
   * pure-reference head); metadata = `{ didDocument: <btco doc w/ fresh #cel
   * head>, events: <delta since last on-chain head> | celLog: <full snapshot> }`.
   * Mirrors `reinscribeRotatedDoc`'s sat-pin + rollback: on failure (nothing paid
   * before broadcast) the pre-append log is restored so the in-memory log never
   * runs ahead of the chain.
   */
  private async inscribeCelAppend(asset: OriginalsAsset, headDigest: string): Promise<void> {
    const log = asset.celLog;
    const btcoDid = asset.bindings?.['did:btco'];
    if (!log || !btcoDid) return; // defensive: btco asset always has both
    const satoshi = btcoDid.split(':').pop()!;

    // Rebuild the btco doc with the CURRENT controller key + refreshed resource
    // manifest, then embed the fresh #cel head (the just-appended event).
    const vm = currentControllerVm(log);
    const controllerPubMb = vm.split('#')[0].slice('did:key:'.length);
    const btcoDoc = this.buildRotatedBtcoDoc(asset, satoshi, btcoDid, controllerPubMb);
    this.embedCelAnchor(btcoDoc, headDigest);

    // Delta since the last on-chain head, else a full snapshot (safe checkpoint).
    const metadata: Record<string, unknown> = { didDocument: btcoDoc };
    const lastHead = this.lastInscribedHead.get(asset);
    const boundaryIdx = lastHead !== undefined
      ? log.events.findIndex(ev => digestMultibaseEquals(lastHead, computeDigestMultibase(canonicalizeEntryForChain(ev))))
      : -1;
    if (boundaryIdx >= 0 && boundaryIdx < log.events.length - 1) {
      const delta = log.events.slice(boundaryIdx + 1);
      metadata.events = JSON.parse(serializeEventLogJson({ ...log, events: delta })).events;
    } else {
      // No known boundary → full snapshot; the resolver treats it as a checkpoint.
      metadata.celLog = JSON.parse(serializeEventLogJson(log)) as Record<string, unknown>;
    }

    const headMedia = this.tryResolveHeadMedia(asset);
    // Cost surfacing (spec §0/§5): estimate + emit BEFORE the paid broadcast.
    await this.emitInscribeCost(asset, headMedia?.content ?? Buffer.from(JSON.stringify(btcoDoc)));

    const celLogBefore = log;
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    let inscription: { inscriptionId: string; satoshi?: string; txid?: string; revealTxId?: string };
    try {
      inscription = await bitcoinManager.inscribeData(
        headMedia ? headMedia.content : Buffer.from(JSON.stringify(btcoDoc)),
        headMedia ? headMedia.contentType : 'application/did+json',
        undefined,
        { targetSatoshi: satoshi, metadata, lockKey: asset.id }
      );
    } catch (error) {
      // Failed after the append — restore the pre-append log (nothing was paid).
      asset._replaceCelLog(celLogBefore);
      throw error;
    }

    // Attach the head's own bitcoin witness proof (post-hoc; excluded from the
    // chain digest, so it cannot break the anchored head). Then capture the
    // updated btco doc and advance the on-chain head boundary.
    if (inscription.satoshi) {
      this.attachBitcoinWitnessProof(asset, {
        satoshi: inscription.satoshi,
        inscriptionId: inscription.inscriptionId,
        txid: inscription.revealTxId ?? inscription.txid ?? ''
      });
    }
    asset._captureDidDocument('did:btco', btcoDoc);
    this.lastInscribedHead.set(asset, headDigest);

    await this.eventEmitter.emit({
      type: 'resource:inscribed',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      did: btcoDid,
      inscriptionId: inscription.inscriptionId
    });
  }

  /**
   * Best-effort cost estimate for a btco append inscription (spec §0/§5). Emits
   * `cel:inscribe-cost` with the resolved fee rate and an approximate total sat
   * cost (fee rate × rough vsize). Never gates — an estimator failure must not
   * block the paid op the caller already intends.
   */
  private async emitInscribeCost(asset: OriginalsAsset, content: Buffer): Promise<void> {
    try {
      const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
      const feeRate = await bitcoinManager.estimateFeeRate();
      // Rough commit+reveal vsize: content bytes / 4 (witness discount) + ~200
      // vB overhead. A ballpark for cost-awareness, not a billing figure.
      const estVsize = Math.ceil(content.byteLength / 4) + 200;
      const estSats = typeof feeRate === 'number' ? Math.ceil(feeRate * estVsize) : undefined;
      await this.eventEmitter.emit({
        type: 'cel:inscribe-cost',
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        ...(typeof feeRate === 'number' ? { feeRate } : {}),
        estVsize,
        ...(estSats !== undefined ? { estSats } : {})
      });
    } catch {
      // non-gating
    }
  }

  /**
   * Resolve the media the anchoring inscription will carry as CONTENT (#407
   * phase 2): the most-recent resource's inline bytes + its MIME type. The head
   * is derived from the LOG (mostRecentResourceHead) — the same source the
   * verifier uses — then matched by hash to the in-memory resources array to
   * recover the bytes.
   *
   * Returns null when no inline media is available (the head resource is a pure
   * reference — hosted/hash-only, no inline bytes). Provenance still rides in
   * metadata; the caller falls back to inscribing the DID document as content,
   * so such assets carry NO media on-chain (honest, per the reference-only
   * pattern this SDK supports — content-as-ordinal applies to inline media only).
   */
  private tryResolveHeadMedia(asset: OriginalsAsset): { content: Buffer; contentType: string } | null {
    const log = asset.celLog;
    if (!log) return null;
    const head = mostRecentResourceHead(log);
    if (!head) return null;
    const res = asset.resources.find(r => (!head.resourceId || r.id === head.resourceId) && r.hash === head.hash);
    if (!res || typeof res.content !== 'string') return null;
    return {
      content: Buffer.from(res.content, 'utf8'),
      contentType: res.contentType ?? head.contentType ?? 'application/octet-stream'
    };
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
    if (asset.currentLayer !== 'did:webvh' && asset.currentLayer !== 'did:cel') {
      throw new StructuredError('NOT_IMPLEMENTED', 'Asset inscription is not yet implemented for this layer. Assets must be in the genesis layer (did:cel) or did:webvh layer to inscribe.');
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
    // Anchor-in-signed-body (design 2026-07-13): the btco migrate event is
    // signed INSIDE buildContent, where the target sat is pinned, so its body
    // can carry the resolvable `to: did:btco:<network>:<sat>`. Snapshot the
    // pre-append log here for rollback; the append itself is deferred below.
    celLogBefore = asset.celLog;
    const network = this.getConfiguredBitcoinNetwork();
    // Resource manifest rides INSIDE the DID document as a service entry —
    // the inscription itself must be the DID document (application/did+json)
    // or the SDK's own BtcoDidResolver rejects it (#375).
    const manifestEndpoint = {
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    // First-anchor-wins uniqueness (#did-cel-uniqueness): the inscribed btco
    // doc MUST back-link its did:cel so on-chain anchorings are enumerable via
    // getAnchoringsForDidCel. Derive it from the genesis event (not the mutable
    // asset.id) and place it first; dedupe so a coincidental asset.id === didCel
    // does not double-list. The did:webvh predecessor follows.
    const didCel = asset.celLog ? deriveDidCel(asset.celLog) : asset.id;
    const backLinks = [didCel, asset.id, asset.bindings?.['did:webvh']].filter(
      (d, i, arr): d is string => typeof d === 'string' && arr.indexOf(d) === i
    );

    // #407 phase 2: the anchoring inscription IS the asset. Its CONTENT is the
    // current media (the most-recent resource's bytes), resolved from the LOG so
    // writer and verifier agree; its METADATA carries the byte-light provenance
    // (DID doc + CEL log). The media is sat-independent, so resolve it before the
    // deferred window. When the head resource is a pure reference (no inline
    // bytes), fall back to inscribing the DID document as content — provenance is
    // still in metadata, just no media on-chain.
    const headMedia = this.tryResolveHeadMedia(asset);
    const inscriptionContentType = headMedia ? headMedia.contentType : 'application/did+json';
    // Held locally, not captured into the asset yet: buildContent runs BEFORE
    // the inscription is confirmed (satoshi known, asset.migrate succeeded).
    // Capturing here would leave a stale doc in #didDocuments with no rollback
    // if the operation fails afterward (e.g. ORD_SATOSHI_UNKNOWN) — mirrors
    // rotateBtcoKeys' post-success capture.
    let inscribedBtcoDoc: DIDDocument | undefined;
    const inscription = await bitcoinManager.inscribeData(
      async (satoshi: string) => {
        // Sign the migrate event NOW that the sat is pinned: the body carries
        // the resolvable did:btco anchor, and the DID doc's #cel commits to
        // this event's digest — so the append MUST precede doc construction.
        celHeadDigest = await this.appendCelEventOrSkip(asset, 'migrate', {
          sourceDid: asset.bindings?.['did:webvh'] ?? asset.id,
          layer: 'btco',
          network,
          to: btcoDidFromSatoshi(satoshi, network),
          migratedAt: new Date().toISOString()
        });
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
        // Metadata = { didDocument, celLog }. Snapshot the log AFTER the migrate
        // append so the embedded celLog head equals the #cel anchor digest.
        return {
          content: headMedia ? headMedia.content : Buffer.from(JSON.stringify(btcoDoc)),
          metadata: {
            didDocument: btcoDoc,
            ...(asset.celLog ? { celLog: JSON.parse(serializeEventLogJson(asset.celLog)) as Record<string, unknown> } : {})
          }
        };
      },
      inscriptionContentType,
      feeRate,
      // Key the shared money-lock by the asset's current DID so a concurrent
      // MigrationManager.migrate of the same DID is blocked at inscribe (issue #303).
      { lockKey: asset.id }
    ) as {
      revealTxId?: string;
      txid: string;
      commitTxId?: string;
      inscriptionId: string;
      satoshi?: string;
      feeRate?: number;
      content?: Buffer;
      metadata?: Record<string, unknown>;
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
      // #407 phase 3: the migrate event is now the on-chain head; a subsequent
      // btco resource-update inscribes only the delta appended after it.
      this.lastInscribedHead.set(asset, celHeadDigest);
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
    // Cross-check the echoed METADATA DID document (#407 phase 2 moved the doc
    // from content→metadata): if the provider echoed a didDocument whose id
    // disagrees with the computed binding, it may have altered the inscription —
    // log it (payment already happened, state is migrated; do NOT throw, the
    // caller has the inscriptionId to investigate). Missing metadata is fine —
    // no cross-check possible.
    {
      const inscribedDoc = (inscription.metadata as { didDocument?: { id?: unknown } } | undefined)?.didDocument;
      if (inscribedDoc && inscribedDoc.id !== bindingValue) {
        this.logger.error(
          'Inscribed DID document id does not match expected binding — provider may have altered the inscription metadata',
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

    // Best-effort pre-move sat holder, purely for the event payload. Ownership
    // is the sat, read live from the chain; we NEVER fabricate `from` — if the
    // provider has no owner index, or the lookup fails, we omit it (#366).
    let from: string | undefined;
    const ownershipProvider = this.config.ordinalsProvider;
    if (satoshi && ownershipProvider?.getSatOwnership) {
      try {
        from = (await ownershipProvider.getSatOwnership(satoshi))?.address;
      } catch {
        from = undefined;
      }
    }

    const tx = await bm.transferInscription(inscription, newOwner);

    // Ownership = sat control (this Bitcoin tx). The CEL is authorship only, so
    // a transfer writes NOTHING to the log. Emit asset:transferred on BOTH the
    // asset's private emitter and the manager emitter (issue #346: the asset
    // emitter alone left sdk.lifecycle.on(...) subscribers unnotified).
    const transferredEvent = {
      type: 'asset:transferred' as const,
      timestamp: new Date().toISOString(),
      asset: { id: asset.id, layer: asset.currentLayer },
      ...(from !== undefined ? { from } : {}),
      to: newOwner,
      transactionId: tx.txid
    };
    await asset._internalEmit(transferredEvent);
    await this.eventEmitter.emit(transferredEvent);

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

  // ===== Shared rotation-first core (rotateBtcoKeys + authorizeSigner) =====

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
   * authorizeSigner): same id, the NEW verification method, lineage back-links,
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
    // #407 phase 2: the reinscription IS the asset. Content = current media;
    // metadata = { didDocument: rotatedDoc, celLog }. The sat is already known
    // (reinscription targets it), so both are built synchronously; snapshot the
    // log now — the caller has already appended the rotateKey + embedded the
    // fresh #cel anchor, so the celLog head equals that anchor. No inline media
    // (pure-reference head) → fall back to the DID document as content.
    const headMedia = this.tryResolveHeadMedia(asset);
    const metadata: Record<string, unknown> = {
      didDocument: rotatedDoc,
      ...(asset.celLog ? { celLog: JSON.parse(serializeEventLogJson(asset.celLog)) as Record<string, unknown> } : {})
    };
    try {
      return await bitcoinManager.inscribeData(
        headMedia ? headMedia.content : Buffer.from(JSON.stringify(rotatedDoc)),
        headMedia ? headMedia.contentType : 'application/did+json',
        feeRate,
        { targetSatoshi: satoshi, metadata }
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
   * the STANDARD append path — folds to the CURRENT controller (for
   * authorizeSigner, the NEW key post-rotation). Non-gating: `replayProvenance`
   * ignores updates and the verifier never requires it. Best-effort — the
   * inscription is already committed and paid, so a failed acknowledgment
   * must not undo it. As a side
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
   * Rotation-first optional authoring (#366): reinscribe the did:btco
   * document — same id, new verification method — on the SAME sat. Only the
   * current UTXO holder can do this (reinscription spends the output), so a
   * successful rotation simultaneously proves sat control and announces the
   * signing key the (already-owning) sat holder will author future
   * provenance with. The resolver's newest-valid-inscription rule then
   * serves the rotated document.
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
    // authorized by the outgoing authority). The non-cooperative arm (a sat
    // holder who cannot obtain the prior controller's signature) is
    // authorizeSigner.
    // Canonical VM the post-rotation controller will sign appends under.
    const newController = `did:key:${newVerificationMethod.publicKeyMultibase}`;
    const newControllerVm = `${newController}#${newVerificationMethod.publicKeyMultibase}`;
    // Register the incoming controller's private key so post-rotation appends
    // can sign (key-custody contract). Before the append is fine — the rotateKey
    // event itself is signed by the OUTGOING controller; this key is for what
    // follows.
    // Assert the pair whenever a privateKey is supplied (mirrors authorizeSigner);
    // registering it needs a keyStore, but the derive-check must not be skipped
    // just because none is configured — a mismatched key must fail loudly.
    if (newVerificationMethod.privateKey) {
      this.assertRotationKeyPair(newVerificationMethod.publicKeyMultibase, newVerificationMethod.privateKey);
      if (this.keyStore) {
        await this.keyStore.setPrivateKey(newControllerVm, newVerificationMethod.privateKey);
      }
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
    // #407 phase 3: the rotateKey event is the new on-chain head; a subsequent
    // btco resource-update inscribes only the delta appended after it.
    if (celHeadDigest !== null) {
      this.lastInscribedHead.set(asset, celHeadDigest);
    }

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
   * Optional author-enablement (#366, design §5): the write side of the
   * verifier rule Task 5 landed. Ownership itself is the sat — this method
   * does not grant or claim it. It lets the sat holder establish a signing
   * key in the log so they can author new provenance even when they CANNOT
   * obtain the prior controller's signature: they reinscribe the did:btco
   * document — same id, THEIR key — on the same sat, and self-sign the
   * rotateKey with that new key. Because only the current UTXO holder can
   * reinscribe, the reinscription is itself proof of sat control; the
   * verifier accepts the otherwise-unauthorized rotation once the attached
   * bitcoin witness proof (check (a)), the announced key (b), the signer
   * (c), and the strictly-later inscription index (d) all line up.
   *
   * Differs from {@link rotateBtcoKeys} (the COOPERATIVE arm): the rotateKey is
   * SELF-SIGNED with the new key (explicitly NOT the standard append path,
   * which folds to the prior controller the sat holder does not hold),
   * `privateKey` is REQUIRED (the signer must be able to sign), and a bitcoin
   * witness proof is attached to the rotateKey post-inscription — that is what
   * satisfies the verifier's check (a).
   *
   * @throws INVALID_STATE when the asset is not on did:btco / has no binding.
   * @throws INVALID_INPUT when no privateKey is supplied.
   * @throws INVALID_KEY_PAIR / CEL_ED25519_REQUIRED for a bad keypair.
   * @throws OPERATION_IN_PROGRESS on a concurrent call for the same asset.
   */
  async authorizeSigner(
    asset: OriginalsAsset,
    newVerificationMethod: { publicKeyMultibase: string; privateKey: string },
    feeRate?: number
  ): Promise<{ inscriptionId: string; did: string }> {
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Authorizing a signer requires the asset to be on the did:btco layer.');
    }
    const btcoDid = asset.bindings?.['did:btco'];
    if (!btcoDid) {
      throw new StructuredError('INVALID_STATE', 'Asset has no did:btco binding to authorize a signer for.');
    }
    // privateKey is REQUIRED: the sat holder self-signs the rotateKey with it
    // (the prior controller is unavailable to fold onto).
    if (!newVerificationMethod?.privateKey) {
      throw new StructuredError('INVALID_INPUT', 'authorizeSigner requires the signer\'s private key to self-sign the rotation.');
    }
    // Concurrency guard (issue #255, same pattern as rotateBtcoKeys): reserve the
    // asset synchronously before the first await so two overlapping calls
    // cannot both broadcast reinscriptions.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An operation for asset ${asset.id} is already in progress; concurrent authorizeSigner calls for the same asset would broadcast duplicate reinscriptions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    const satoshi = btcoDid.split(':').pop()!;
    const pkm = newVerificationMethod.publicKeyMultibase;
    // Derive-check the new signer's keypair (privateKey REQUIRED); register it
    // so subsequent appends by the new controller can sign.
    this.assertRotationKeyPair(pkm, newVerificationMethod.privateKey);
    const newController = `did:key:${pkm}`;
    const newControllerVm = `${newController}#${pkm}`;

    // SELF-SIGN the rotateKey with the NEW key — explicitly NOT
    // appendCelEventOrSkip, which folds to the prior controller the sat
    // holder cannot hold. The verifier accepts this unauthorized rotation
    // non-cooperatively once the reinscription witness proves sat control.
    const celLogBefore = asset.celLog;
    if (!celLogBefore) {
      throw new StructuredError('INVALID_STATE', 'Asset has no CEL log to append the rotation to.');
    }
    // Guard above must run BEFORE registering the key: a doomed call (no CEL
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
    // #407 phase 3: the rotateKey event is the new on-chain head; a subsequent
    // btco resource-update inscribes only the delta appended after it.
    this.lastInscribedHead.set(asset, celHeadDigest);

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
   * Create a draft asset (did:cel genesis layer)
   * 
   * This is the entry point for creating new Originals. Draft assets are
   * stored locally and can be published or inscribed later.
   * 
   * @param resources - Array of resources to include in the asset
   * @param options - Optional configuration including progress callback
   * @returns The newly created OriginalsAsset in did:cel genesis layer
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
   * Migrates a draft asset from did:cel to did:webvh, making it publicly
   * discoverable via HTTPS.
   * 
   * @param asset - The asset to publish (must be in did:cel genesis layer)
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
   * @param asset - The asset to inscribe (must be in did:cel genesis or did:webvh layer)
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
      'did:cel': ['did:webvh', 'did:btco'],
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


