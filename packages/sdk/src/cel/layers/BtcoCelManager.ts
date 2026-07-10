/**
 * BtcoCelManager - CEL Manager for did:btco Layer
 * 
 * Manages migration of Originals assets to the did:btco layer (Layer 2).
 * This layer provides Bitcoin-based witnessing for maximum immutability.
 * 
 * The did:btco method anchors asset provenance on the Bitcoin blockchain
 * using ordinals inscriptions, providing the highest level of trust
 * and permanence in the Originals Protocol.
 * 
 * @see https://github.com/aviarytech/did-btco
 */

import type { EventLog, ExternalReference, UpdateOptions, AssetState } from '../types.js';
import { appendEvent } from '../algorithms/appendEvent.js';
import { witnessEvent } from '../algorithms/witnessEvent.js';
import { BitcoinWitness } from '../witnesses/BitcoinWitness.js';
import type { BitcoinManager } from '../../bitcoin/BitcoinManager.js';
import type { CelSigner } from './PeerCelManager.js';
import { btcoDidPrefix } from '../btcoDid.js';
import { deriveDidCel } from '../celDid.js';

/**
 * Configuration options for BtcoCelManager
 */
export interface BtcoCelConfig {
  /** The DID URL of the verification method for signing */
  verificationMethod?: string;
  /** The purpose of proofs (defaults to 'assertionMethod') */
  proofPurpose?: string;
  /** Fee rate in sat/vB for Bitcoin transactions (optional - BitcoinManager will estimate if not provided) */
  feeRate?: number;
  /**
   * Bitcoin network fallback for replaying LEGACY btco logs whose signed
   * migration data predates the recorded `network` field, when no
   * BitcoinManager is configured (read-only replay). New logs record the
   * network in the signed data, so this is never consulted for them.
   */
  network?: 'mainnet' | 'regtest' | 'signet';
}

/**
 * Migration data stored in the update event when migrating to btco
 */
export interface BtcoMigrationData {
  /** The source DID from the previous layer */
  sourceDid: string;
  /**
   * The resolvable did:btco:<satoshi> DID. Optional in the signed event data:
   * the satoshi is only known after inscription, so it is carried in the
   * bitcoin witness proof and the DID is derived from there during state
   * derivation rather than being embedded in (and signed as part of) the data.
   */
  targetDid?: string;
  /** The target layer */
  layer: 'btco';
  /**
   * The Bitcoin network the inscription is made on, recorded at migration time.
   * The network is known before inscription (unlike the satoshi), so it lives in
   * the SIGNED migration data — this lets state derivation reconstruct the
   * network-scoped did:btco identifier deterministically from the log rather
   * than from the replaying SDK's runtime config. Absent on logs created before
   * this field existed.
   */
  network?: 'mainnet' | 'regtest' | 'signet';
  /** The Bitcoin transaction ID anchoring the migration */
  txid?: string;
  /** The inscription ID on Bitcoin */
  inscriptionId?: string;
  /** ISO 8601 timestamp of migration */
  migratedAt: string;
}

/**
 * BtcoCelManager - Manages CEL-based asset migration to did:btco layer
 * 
 * The btco layer is the final publication layer for Originals assets.
 * Assets at this layer:
 * - Have a did:btco identifier anchored on Bitcoin
 * - Have mandatory Bitcoin witness attestations via ordinals
 * - Provide maximum immutability and timestamping
 * - Cannot be migrated to any other layer
 * 
 * @example
 * ```typescript
 * const bitcoinManager = new BitcoinManager(config);
 * const manager = new BtcoCelManager(
 *   async (data) => createEdDsaProof(data, privateKey),
 *   bitcoinManager
 * );
 * 
 * const btcoLog = await manager.migrate(webvhLog);
 * console.log(btcoLog.events[btcoLog.events.length - 1].data.txid);
 * ```
 */
export class BtcoCelManager {
  private signer: CelSigner;
  private bitcoinManager?: BitcoinManager;
  private _bitcoinWitness?: BitcoinWitness;
  private config: BtcoCelConfig;

  /**
   * Creates a new BtcoCelManager instance
   *
   * @param signer - Function that signs data and returns a DataIntegrityProof
   * @param bitcoinManager - BitcoinManager instance for ordinals inscriptions.
   *   Optional: only WRITE operations (migrate — it inscribes) need it; pure
   *   reads like getCurrentState replay the persisted log deterministically
   *   and work without one.
   * @param config - Optional configuration options
   */
  constructor(
    signer: CelSigner,
    bitcoinManager?: BitcoinManager,
    config: BtcoCelConfig = {}
  ) {
    if (typeof signer !== 'function') {
      throw new Error('BtcoCelManager requires a signer function');
    }
    // Guard the optional middle parameter: passing a config object where the
    // BitcoinManager belongs (`new BtcoCelManager(signer, { feeRate: 5 })`)
    // would otherwise be silently accepted and only blow up deep inside
    // migrate(). Duck-type on the one method every manager (and test mock)
    // provides.
    if (
      bitcoinManager !== undefined &&
      typeof (bitcoinManager as unknown as { inscribeData?: unknown }).inscribeData !== 'function'
    ) {
      throw new Error(
        'BtcoCelManager second argument must be a BitcoinManager (or undefined for read-only replay); ' +
        'pass configuration as the third argument.'
      );
    }

    this.signer = signer;
    this.bitcoinManager = bitcoinManager;
    this.config = {
      proofPurpose: 'assertionMethod',
      ...config,
    };
  }

  /** The BitcoinManager, or a clear error for write paths that need one. */
  private requireBitcoinManager(): BitcoinManager {
    if (!this.bitcoinManager) {
      throw new Error('BTCO operations require a BitcoinManager. Provide it in config.btco.bitcoinManager');
    }
    return this.bitcoinManager;
  }

  /** Lazily-created Bitcoin witness service (requires a BitcoinManager). */
  private get bitcoinWitness(): BitcoinWitness {
    if (!this._bitcoinWitness) {
      this._bitcoinWitness = new BitcoinWitness(this.requireBitcoinManager(), {
        feeRate: this.config.feeRate,
        verificationMethod: this.config.verificationMethod,
      });
    }
    return this._bitcoinWitness;
  }

  /**
   * Migrates a webvh layer event log to the did:btco layer
   * 
   * This method:
   * 1. Validates the input log (must have migrated to webvh layer)
   * 2. Creates an update event with migration data
   * 3. Adds mandatory Bitcoin witness proof via ordinals inscription
   * 4. Generates a did:btco DID based on the inscription
   * 5. Returns the updated EventLog
   * 
   * Note: Bitcoin witness is REQUIRED at this layer - it cannot be skipped.
   * 
   * @param webvhLog - The event log from the webvh layer to migrate
   * @returns Promise resolving to an EventLog with the migration event appended
   * 
   * @throws Error if the log is empty, deactivated, or not from webvh layer
   * @throws Error if signer produces invalid proof
   * @throws Error if Bitcoin inscription fails
   */
  async migrate(webvhLog: EventLog): Promise<EventLog> {
    // Migration inscribes on Bitcoin — it is the write path that genuinely
    // needs a BitcoinManager. Fail up front with a clear error.
    const bitcoinManager = this.requireBitcoinManager();

    // Validate input log
    if (!webvhLog || !webvhLog.events || webvhLog.events.length === 0) {
      throw new Error('Cannot migrate an empty event log');
    }

    // Get the create event to extract source DID
    const createEvent = webvhLog.events[0];
    if (createEvent.type !== 'create') {
      throw new Error('First event must be a create event');
    }

    // Find the current layer and DID by checking for migration events
    let currentDid: string | undefined;
    let currentLayer: string | undefined;

    // Look through events to find the latest migration
    for (const event of webvhLog.events) {
      const eventData = event.data as Record<string, unknown>;
      
      if (event.type === 'create') {
        // Dual-read: new-shape genesis (controller present) derives its
        // identity (did:cel); legacy genesis embeds `did` and is read verbatim.
        currentDid = eventData.controller !== undefined
          ? deriveDidCel(webvhLog)
          : (eventData.did as string);
        currentLayer = eventData.layer as string || 'peer';
      } else if (
        // Type-first: first-class 'migrate' events are migrations by type.
        (event.type === 'migrate' && eventData?.layer) ||
        // Legacy sniff kept verbatim: old logs record migrations as 'update'
        // events. Detect via sourceDid (present on both webvh and btco
        // migrations) rather than targetDid (webvh-only), so a log already
        // migrated to btco is recognised as such and the terminal guard below
        // correctly rejects a second btco migration. webvh migrations carry
        // the resolvable targetDid; btco migrations don't, but migrate() only
        // proceeds from the webvh layer anyway.
        (event.type === 'update' && eventData.sourceDid && eventData.layer && eventData.migratedAt)
      ) {
        currentLayer = eventData.layer as string;
        currentDid = (eventData.targetDid as string) ?? (eventData.sourceDid as string);
      }
    }

    if (!currentDid) {
      throw new Error('Could not determine current DID from event log');
    }

    // Validate source is from webvh layer (only webvh can migrate to btco)
    if (currentLayer !== 'webvh') {
      throw new Error(`Cannot migrate from ${currentLayer} layer to btco layer. Must migrate to webvh first.`);
    }

    // Check if log is already deactivated
    const lastEvent = webvhLog.events[webvhLog.events.length - 1];
    if (lastEvent.type === 'deactivate') {
      throw new Error('Cannot migrate a deactivated event log');
    }

    // Finalize the migration data BEFORE signing. The controller signature and
    // the witness digest both commit to {type, data, previousEvent}; mutating
    // `data` after signing (as this code previously did to splice in
    // txid/inscriptionId) invalidates both, so every btco log failed
    // verification. The Bitcoin details cannot be known before the inscription
    // (chicken-and-egg): txid, inscriptionId AND the satoshi that forms the
    // canonical did:btco:<sat> identifier all come from the inscription. They
    // are therefore NOT part of the signed data — they live in the bitcoin
    // witness proof (added after signing, excluded from the chain digest) and
    // the resolvable targetDid is derived from the proof's satoshi at
    // state-derivation time.
    const migrationData: BtcoMigrationData = {
      sourceDid: currentDid,
      layer: 'btco',
      // Record the network in the SIGNED data. The satoshi is not yet known
      // (it comes from the inscription, via the witness proof), but the network
      // is known now — recording it here keeps state derivation deterministic:
      // replaying the log yields the same network-scoped did:btco identifier
      // regardless of the SDK's configured network.
      network: bitcoinManager.network,
      migratedAt: new Date().toISOString(),
    };

    // Build update options
    const updateOptions: UpdateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || `${currentDid}#key-0`,
      proofPurpose: this.config.proofPurpose,
    };

    // Append the (final, signed) first-class migrate event with the migration data.
    const updatedLog = await appendEvent(webvhLog, 'migrate', migrationData, updateOptions);

    // Add the Bitcoin witness proof (REQUIRED at btco layer). This attests the
    // already-signed event content and appends the txid/inscriptionId; it does
    // not — and must not — alter the signed `data`.
    const lastEventIndex = updatedLog.events.length - 1;
    const witnessedEvent = await witnessEvent(updatedLog.events[lastEventIndex], this.bitcoinWitness);

    return {
      ...updatedLog,
      events: [
        ...updatedLog.events.slice(0, lastEventIndex),
        witnessedEvent,
      ],
    };
  }

  /**
   * The network-scoped did:btco prefix for the configured Bitcoin network.
   * Delegates to the shared helper so all btco identifiers the SDK emits
   * (state derivation, CLI display) agree on the prefix.
   */
  private btcoDidPrefix(network: string | undefined): string {
    return btcoDidPrefix(network);
  }

  /**
   * Derives the current asset state by replaying all events in the log.
   *
   * @param log - The event log to derive state from
   * @returns The current AssetState derived from replaying events
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

    // Extract initial state from create event. Dual-read the genesis: a
    // new-shape genesis (`controller` present) derives its identity (did:cel)
    // and sources the creator from the controller; a legacy genesis embeds
    // `did`/`creator` and is read verbatim.
    const createData = createEvent.data as Record<string, unknown>;
    const isLegacyGenesis = createData.controller === undefined && createData.did !== undefined;

    // Initialize state from create event
    const state: AssetState = {
      did: isLegacyGenesis ? (createData.did as string) : deriveDidCel(log),
      name: createData.name as string | undefined,
      layer: (createData.layer as 'peer' | 'webvh' | 'btco') || 'peer',
      resources: (createData.resources as ExternalReference[]) || [],
      creator: (createData.creator as string | undefined) ?? (createData.controller as string | undefined),
      controller: createData.controller as string | undefined,
      createdAt: createData.createdAt as string | undefined,
      updatedAt: undefined,
      deactivated: false,
      metadata: {},
    };

    // Apply subsequent events
    for (let i = 1; i < log.events.length; i++) {
      const event = log.events[i];

      if (event.type === 'update' || event.type === 'migrate') {
        const updateData = event.data as Record<string, unknown>;

        // Type-first: first-class 'migrate' events are migrations by type.
        // Legacy logs record migrations as 'update' events — the sniff via
        // sourceDid + layer (regular updates don't carry them) is kept
        // verbatim as fallback. (btco migrations no longer carry targetDid in
        // the signed data — see below.)
        if (event.type === 'migrate' || (updateData.sourceDid && updateData.layer && updateData.migratedAt)) {
          // Migration event - update DID and layer
          state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
          state.updatedAt = updateData.migratedAt as string;

          // Store migration info in metadata
          state.metadata = state.metadata || {};
          state.metadata.sourceDid = updateData.sourceDid;

          // For btco, the Bitcoin details (txid, inscriptionId, satoshi) are
          // NOT in the signed data — they can't be known before inscription.
          // They are read from the bitcoin witness proof, and the resolvable
          // did:btco:<satoshi> DID is derived from the proof's satoshi.
          if (updateData.layer === 'btco') {
            const bitcoinProof = (event.proof as ReadonlyArray<unknown> | undefined)?.find(
              (p): p is Record<string, unknown> =>
                !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
            );
            if (bitcoinProof?.txid) {
              state.metadata.txid = bitcoinProof.txid;
            }
            if (bitcoinProof?.inscriptionId) {
              state.metadata.inscriptionId = bitcoinProof.inscriptionId;
            }
            if (bitcoinProof?.satoshi) {
              state.metadata.satoshi = bitcoinProof.satoshi;
              // Canonical, resolvable did:btco identifier. The identifier is
              // network-scoped: only mainnet is bare (`did:btco:<sat>`), while
              // signet/regtest carry a prefix (`did:btco:sig:` / `did:btco:reg:`),
              // matching DIDManager/createBtcoDidDocument. The network is read
              // from the SIGNED migration data so replaying a persisted log is
              // deterministic — the DID does not change with the replaying SDK's
              // configured network. Fall back to a configured BitcoinManager's
              // network only for legacy logs written before the network was
              // recorded; without either source, deriving a DID would just be
              // guessing the network, so fail closed with a clear error.
              const network = (updateData.network as string | undefined)
                ?? this.bitcoinManager?.network
                ?? this.config.network;
              if (updateData.network === undefined && !this.bitcoinManager && this.config.network === undefined) {
                throw new Error(
                  'Legacy btco log does not record its Bitcoin network in the signed migration data; ' +
                  'configure a BitcoinManager (config.btco.bitcoinManager) or a fallback network ' +
                  '(BtcoCelConfig.network) so the network can be supplied.'
                );
              }
              state.metadata.network = network;
              state.did = `${this.btcoDidPrefix(network)}:${bitcoinProof.satoshi as string}`;
            }
          } else {
            // Non-btco (webvh) migrations carry their targetDid in the data
            // (domain-derived, known at signing time).
            if (updateData.targetDid) {
              state.did = updateData.targetDid as string;
            }
            if (updateData.domain) {
              state.metadata.domain = updateData.domain;
            }
          }
        } else {
          // Regular update event
          if (updateData.name !== undefined) {
            state.name = updateData.name as string;
          }
          if (updateData.resources !== undefined) {
            state.resources = updateData.resources as ExternalReference[];
          }
          if (updateData.updatedAt !== undefined) {
            state.updatedAt = updateData.updatedAt as string;
          }
          if (updateData.did !== undefined) {
            state.did = updateData.did as string;
          }
          if (updateData.layer !== undefined) {
            state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
          }
        }
        
        // Store other fields in metadata. `network` is consumed (and stored)
        // explicitly only for btco migration events, so exclude it here for
        // those events alone — for an ordinary update, an application-defined
        // `network` field must still flow through to metadata.
        const excludedKeys = ['name', 'resources', 'updatedAt', 'did', 'layer', 'creator', 'createdAt', 'sourceDid', 'targetDid', 'domain', 'migratedAt', 'txid', 'inscriptionId'];
        const isBtcoMigration = updateData.layer === 'btco' &&
          (event.type === 'migrate' || (updateData.sourceDid && updateData.migratedAt));
        if (isBtcoMigration) {
          excludedKeys.push('network');
        }
        for (const [key, value] of Object.entries(updateData)) {
          if (!excludedKeys.includes(key)) {
            state.metadata = state.metadata || {};
            state.metadata[key] = value;
          }
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

  /**
   * Gets the BitcoinManager instance used by this manager (undefined when the
   * manager was constructed for read-only replay without one)
   */
  get bitcoin(): BitcoinManager | undefined {
    return this.bitcoinManager;
  }
}
