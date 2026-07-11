/**
 * PeerCelManager - CEL Manager for the genesis (peer) layer
 *
 * Creates and manages Originals assets at the genesis layer (Layer 0).
 * The asset's identity is a `did:cel` derived from the signed create event;
 * the holder's key DID lives in the genesis `controller` field. No witnesses
 * are required at this layer.
 *
 * Legacy logs whose genesis embeds a did:peer (`PeerAssetData`) remain
 * readable on the update/getCurrentState paths.
 */

import type { EventLog, ExternalReference, DataIntegrityProof, CreateOptions, UpdateOptions, AssetState } from '../types.js';
import { createEventLog } from '../algorithms/createEventLog.js';
import { updateEventLog } from '../algorithms/updateEventLog.js';
import { deriveDidCel } from '../celDid.js';
import { multibase } from '../../utils/encoding.js';

/**
 * Configuration options for PeerCelManager
 */
export interface PeerCelConfig {
  /** The DID URL of the verification method for signing */
  verificationMethod?: string;
  /** The purpose of proofs (defaults to 'assertionMethod') */
  proofPurpose?: string;
  /** Key type to use for DID generation (defaults to 'Ed25519') */
  keyType?: 'Ed25519' | 'ES256K' | 'ES256';
}

/**
 * Genesis (create-event) data for a did:cel asset.
 *
 * The asset's identity (`did:cel`) is DERIVED FROM this event, so the event
 * must NOT embed it. Identity, holder, and ownership are distinct axes:
 * `controller` is the HOLDER's key DID (a `did:key`), never the asset DID.
 * The `nonce` guarantees two otherwise-identical genesis events derive
 * different DIDs.
 */
export interface CelAssetData {
  /** Asset name */
  name: string;
  /** The holder's key DID (did:key) — distinct from the derived asset did:cel */
  controller: string;
  /** External resources associated with the asset */
  resources: ExternalReference[];
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Multibase base64url of 16 random bytes — collision insurance for the derived DID */
  nonce: string;
}

/**
 * @deprecated Legacy genesis shape (pre-did:cel). Still readable on the verify
 * and getCurrentState paths; the write path now emits {@link CelAssetData}.
 */
export interface PeerAssetData {
  /** Asset name */
  name: string;
  /** Asset DID (did:peer) */
  did: string;
  /** Current layer */
  layer: 'peer';
  /** External resources associated with the asset */
  resources: ExternalReference[];
  /** Creator DID (same as asset DID for peer layer) */
  creator: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/**
 * Signer function type that produces a DataIntegrityProof
 */
export type CelSigner = (data: unknown) => Promise<DataIntegrityProof>;

/**
 * PeerCelManager - Manages CEL-based assets at the genesis layer
 *
 * The genesis layer is the initial layer for creating new Originals assets.
 * Assets at this layer:
 * - Have a did:cel identifier derived from the signed create event
 * - Are controlled by the holder's key pair (genesis `controller`)
 * - Do not require witnesses (empty witness array)
 * - Can be migrated to did:webvh or did:btco layers
 *
 * @example
 * ```typescript
 * const manager = new PeerCelManager(async (data) => {
 *   // Sign with your private key
 *   return createEdDsaProof(data, privateKey);
 * });
 *
 * const { log, did } = await manager.create('My Asset', [
 *   { digestMultibase: 'uXYZ...', mediaType: 'image/png' }
 * ]);
 * ```
 */
export class PeerCelManager {
  private signer: CelSigner;
  private config: PeerCelConfig;

  /**
   * Creates a new PeerCelManager instance
   * 
   * @param signer - Function that signs data and returns a DataIntegrityProof
   * @param config - Optional configuration options
   */
  constructor(signer: CelSigner, config: PeerCelConfig = {}) {
    if (typeof signer !== 'function') {
      throw new Error('PeerCelManager requires a signer function');
    }
    this.signer = signer;
    this.config = {
      proofPurpose: 'assertionMethod',
      keyType: 'Ed25519',
      ...config,
    };
  }

  /**
   * Creates a new asset: builds the de-self-referenced genesis event and
   * derives the asset's `did:cel` from it.
   *
   * This method:
   * 1. Determines the holder's `controller` DID from the signer/config
   * 2. Creates a "create" event carrying {@link CelAssetData} (no asset DID —
   *    identity is derived, not embedded)
   * 3. Signs the event using the provided signer
   * 4. Derives the `did:cel` from the signed genesis event
   *
   * @param name - Human-readable name for the asset
   * @param resources - External resources associated with the asset
   * @returns The genesis EventLog and the derived `did:cel`
   *
   * @throws Error if signer produces invalid proof
   * @throws Error if the controller cannot be determined
   */
  async create(
    name: string,
    resources: ExternalReference[]
  ): Promise<{ log: EventLog; did: string }> {
    // Validate inputs
    if (!name || typeof name !== 'string') {
      throw new Error('Asset name is required and must be a string');
    }
    if (!Array.isArray(resources)) {
      throw new Error('Resources must be an array');
    }

    // The holder's key DID — the asset DID is derived, never embedded here.
    const controller = await this.resolveController();

    // Prepare de-self-referenced genesis data. nonce = 'u' + base64url(16 bytes)
    // so identical {name, controller, resources, createdAt} never collide.
    const assetData: CelAssetData = {
      name,
      controller,
      resources,
      createdAt: new Date().toISOString(),
      nonce: multibase.encode(crypto.getRandomValues(new Uint8Array(16)), 'base64url'),
    };

    // Build create options. createEventLog signs over {type,data} only; the VM
    // is set to the controller's canonical did:key VM for real signers.
    const createOptions: CreateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || this.canonicalControllerVm(controller),
      proofPurpose: this.config.proofPurpose,
    };

    // Create the event log, then derive the did:cel from the signed genesis.
    const log = await createEventLog(assetData, createOptions);
    const did = deriveDidCel(log);

    return { log, did };
  }

  /**
   * Determines the holder's controller DID. Prefers `config.verificationMethod`;
   * otherwise probes the signer for the verificationMethod it reports (the probe
   * signature is discarded). The controller is the DID portion (before '#').
   *
   * A signing FAILURE propagates rather than being swallowed: an asset whose
   * controller cannot be established is unusable, so failing loudly at creation
   * time beats emitting a log that cannot be authored against.
   */
  private async resolveController(): Promise<string> {
    const vm =
      this.config.verificationMethod ?? (await this.discoverSignerVerificationMethod());
    if (!vm) {
      throw new Error(
        'Cannot determine controller: no verificationMethod in config and the signer did not report one'
      );
    }
    const hashIdx = vm.indexOf('#');
    return hashIdx > 0 ? vm.slice(0, hashIdx) : vm;
  }

  /** The controller's canonical verification method (`<did>#<key>` for did:key). */
  private canonicalControllerVm(controller: string): string {
    if (controller.startsWith('did:key:')) {
      return `${controller}#${controller.slice('did:key:'.length)}`;
    }
    return `${controller}#key-0`;
  }

  /**
   * Reads the verificationMethod the signer reports by asking it to sign a
   * discarded probe payload. Returns null when the signer reports no string VM.
   */
  private async discoverSignerVerificationMethod(): Promise<string | null> {
    const probeProof = await this.signer({ type: 'originals-vm-discovery-probe' });
    const vm = probeProof?.verificationMethod;
    return typeof vm === 'string' ? vm : null;
  }

  /**
   * Updates an existing event log by appending an update event.
   * 
   * The new event is cryptographically linked to the previous event
   * via a hash chain (previousEvent field).
   * 
   * @param log - The existing event log to update
   * @param data - The update data (new metadata, resources, etc.)
   * @returns Promise resolving to a new EventLog with the update event appended
   * 
   * @throws Error if the log is empty or deactivated
   * @throws Error if signer produces invalid proof
   * 
   * @example
   * ```typescript
   * const updatedLog = await manager.update(log, {
   *   name: 'Renamed Asset',
   *   description: 'Updated description'
   * });
   * ```
   */
  async update(log: EventLog, data: unknown): Promise<EventLog> {
    // Validate input log
    if (!log || !log.events || log.events.length === 0) {
      throw new Error('Cannot update an empty event log');
    }

    // Check if log is already deactivated
    const lastEvent = log.events[log.events.length - 1];
    if (lastEvent.type === 'deactivate') {
      throw new Error('Cannot update a deactivated event log');
    }

    // Derive the fallback verification method from the create event. New-shape
    // logs must NOT fall back to `did:cel:...#key-0` (unresolvable) — use the
    // controller's canonical did:key VM; legacy logs keep the old expression.
    const createData = log.events[0].data as Partial<CelAssetData & PeerAssetData>;
    const fallbackVm = createData.controller
      ? this.canonicalControllerVm(createData.controller)
      : `${createData.did}#key-0`;

    // Build update options using the same signer
    const updateOptions: UpdateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || fallbackVm,
      proofPurpose: this.config.proofPurpose,
    };

    // Add timestamp to update data
    const updateData = {
      ...((typeof data === 'object' && data !== null) ? data : { value: data }),
      updatedAt: new Date().toISOString(),
    };

    // Delegate to updateEventLog algorithm
    return updateEventLog(log, updateData, updateOptions);
  }

  /**
   * Derives the current asset state by replaying all events in the log.
   * 
   * This method:
   * 1. Starts with the initial state from the create event
   * 2. Applies each update event sequentially
   * 3. Marks as deactivated if a deactivate event is present
   * 
   * @param log - The event log to derive state from
   * @returns The current AssetState derived from replaying events
   * 
   * @throws Error if the log is empty
   * @throws Error if the first event is not a create event
   * 
   * @example
   * ```typescript
   * const state = manager.getCurrentState(log);
   * console.log(state.name);       // Current asset name
   * console.log(state.deactivated); // Whether asset is deactivated
   * ```
   */
  getCurrentState(log: EventLog): AssetState {
    // Validate input log
    if (!log || !log.events || log.events.length === 0) {
      throw new Error('Cannot get state from an empty event log');
    }

    // First event must be a create event
    const createEvent = log.events[0];
    if (createEvent.type !== 'create') {
      throw new Error('First event must be a create event');
    }

    // Dual-read the genesis. New shape (`controller` present): the asset DID is
    // derived (did:cel), `creator` is sourced from the controller, layer is
    // definitionally 'peer'. Legacy shape (`did` present): read verbatim.
    const createData = createEvent.data as Partial<CelAssetData & PeerAssetData>;
    const isLegacy = createData.controller === undefined && createData.did !== undefined;

    // Shapeless genesis (neither controller nor did): the verifier reports no
    // assetDid for this shape (verifyEventLog.ts), so minting a did:cel here
    // would produce state for a DID the log cannot back. Fail closed instead.
    if (createData.controller === undefined && createData.did === undefined) {
      throw new Error(
        'Cannot derive asset state: genesis create event has neither `controller` nor `did`'
      );
    }

    // Initialize state from create event
    const state: AssetState = {
      did: isLegacy ? (createData.did as string) : deriveDidCel(log),
      name: createData.name,
      layer: isLegacy ? (createData.layer as 'peer') : 'peer',
      resources: [...(createData.resources ?? [])],
      creator: isLegacy ? createData.creator : createData.controller,
      controller: createData.controller,
      createdAt: createData.createdAt,
      updatedAt: undefined,
      deactivated: false,
      metadata: {},
    };

    // Apply subsequent events
    for (let i = 1; i < log.events.length; i++) {
      const event = log.events[i];

      if (event.type === 'update') {
        // Merge update data into state
        const updateData = event.data as Record<string, unknown>;
        
        // Update specific known fields
        if (updateData.name !== undefined) {
          state.name = updateData.name as string;
        }
        if (updateData.resources !== undefined) {
          state.resources = updateData.resources as ExternalReference[];
        }
        if (updateData.updatedAt !== undefined) {
          state.updatedAt = updateData.updatedAt as string;
        }
        // did/layer overrides are a legacy-log affordance only: new-shape logs
        // derive identity from the genesis (did:cel) and never rewrite it here.
        if (isLegacy && updateData.did !== undefined) {
          state.did = updateData.did as string;
        }
        if (isLegacy && updateData.layer !== undefined) {
          state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
        }
        
        // Store other fields in metadata
        for (const [key, value] of Object.entries(updateData)) {
          if (!['name', 'resources', 'updatedAt', 'did', 'layer', 'creator', 'createdAt'].includes(key)) {
            state.metadata = state.metadata || {};
            state.metadata[key] = value;
          }
        }
      } else if (event.type === 'migrate') {
        // First-class migration event: layer transition with the same payload
        // fields legacy update-sniffed migrations carried.
        const migrationData = event.data as Record<string, unknown>;
        if (migrationData.targetDid !== undefined) {
          state.did = migrationData.targetDid as string;
        }
        if (migrationData.layer !== undefined) {
          state.layer = migrationData.layer as 'peer' | 'webvh' | 'btco';
        }
        if (migrationData.migratedAt !== undefined) {
          state.updatedAt = migrationData.migratedAt as string;
        }
        state.metadata = state.metadata || {};
        if (migrationData.sourceDid !== undefined) {
          state.metadata.sourceDid = migrationData.sourceDid;
        }
        if (migrationData.domain !== undefined) {
          state.metadata.domain = migrationData.domain;
        }
      } else if (event.type === 'transfer') {
        // Ownership hand-off: surface the owners; identity (did) is unchanged.
        const transferData = event.data as Record<string, unknown>;
        if (transferData.transferredAt !== undefined) {
          state.updatedAt = transferData.transferredAt as string;
        }
        state.metadata = state.metadata || {};
        if (transferData.previousOwner !== undefined) {
          state.metadata.previousOwner = transferData.previousOwner;
        }
        if (transferData.newOwner !== undefined) {
          state.metadata.newOwner = transferData.newOwner;
        }
        if (transferData.txid !== undefined) {
          state.metadata.txid = transferData.txid;
        }
      } else if (event.type === 'rotateKey') {
        // Authority hand-off: the last rotation's newController is current.
        const rotationData = event.data as Record<string, unknown>;
        if (typeof rotationData?.newController === 'string') {
          state.controller = rotationData.newController;
        }
        if (typeof rotationData?.rotatedAt === 'string') {
          state.updatedAt = rotationData.rotatedAt;
        }
      } else if (event.type === 'deactivate') {
        state.deactivated = true;

        // Extract deactivation details
        const deactivateData = event.data as Record<string, unknown>;
        if (deactivateData.deactivatedAt !== undefined) {
          state.updatedAt = deactivateData.deactivatedAt as string;
        }
        if (deactivateData.reason !== undefined) {
          state.metadata = state.metadata || {};
          state.metadata.deactivationReason = deactivateData.reason;
        }
      }
    }

    return state;
  }
}
