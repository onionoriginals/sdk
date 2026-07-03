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
import { updateEventLog } from '../algorithms/updateEventLog.js';
import { witnessEvent } from '../algorithms/witnessEvent.js';
import { BitcoinWitness } from '../witnesses/BitcoinWitness.js';
import type { BitcoinManager } from '../../bitcoin/BitcoinManager.js';
import type { CelSigner } from './PeerCelManager.js';

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
  private bitcoinManager: BitcoinManager;
  private bitcoinWitness: BitcoinWitness;
  private config: BtcoCelConfig;

  /**
   * Creates a new BtcoCelManager instance
   * 
   * @param signer - Function that signs data and returns a DataIntegrityProof
   * @param bitcoinManager - BitcoinManager instance for ordinals inscriptions
   * @param config - Optional configuration options
   */
  constructor(
    signer: CelSigner,
    bitcoinManager: BitcoinManager,
    config: BtcoCelConfig = {}
  ) {
    if (typeof signer !== 'function') {
      throw new Error('BtcoCelManager requires a signer function');
    }
    if (!bitcoinManager) {
      throw new Error('BtcoCelManager requires a BitcoinManager instance');
    }
    
    this.signer = signer;
    this.bitcoinManager = bitcoinManager;
    this.config = {
      proofPurpose: 'assertionMethod',
      ...config,
    };
    
    // Create Bitcoin witness service with optional fee rate
    this.bitcoinWitness = new BitcoinWitness(bitcoinManager, {
      feeRate: config.feeRate,
      verificationMethod: config.verificationMethod,
    });
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
        currentDid = eventData.did as string;
        currentLayer = eventData.layer as string || 'peer';
      } else if (event.type === 'update' && eventData.sourceDid && eventData.layer) {
        // This is a migration event. Detect via sourceDid (present on both
        // webvh and btco migrations) rather than targetDid (webvh-only), so a
        // log already migrated to btco is recognised as such and the terminal
        // guard below correctly rejects a second btco migration. webvh
        // migrations carry the resolvable targetDid; btco migrations don't, but
        // migrate() only proceeds from the webvh layer anyway.
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
      network: this.bitcoinManager.network,
      migratedAt: new Date().toISOString(),
    };

    // Build update options
    const updateOptions: UpdateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || `${currentDid}#key-0`,
      proofPurpose: this.config.proofPurpose,
    };

    // Create the (final, signed) update event with the migration data.
    const updatedLog = await updateEventLog(webvhLog, migrationData, updateOptions);

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
   * Mainnet is bare (`did:btco`); signet/regtest carry `sig`/`reg` segments.
   * Mirrors DIDManager / createBtcoDidDocument so all btco identifiers agree.
   */
  private btcoDidPrefix(network: string | undefined): string {
    switch (network) {
      case 'signet':
        return 'did:btco:sig';
      case 'regtest':
        return 'did:btco:reg';
      default:
        return 'did:btco';
    }
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

    // Extract initial state from create event
    const createData = createEvent.data as Record<string, unknown>;
    
    // Initialize state from create event
    const state: AssetState = {
      did: createData.did as string,
      name: createData.name as string | undefined,
      layer: (createData.layer as 'peer' | 'webvh' | 'btco') || 'peer',
      resources: (createData.resources as ExternalReference[]) || [],
      creator: createData.creator as string | undefined,
      createdAt: createData.createdAt as string | undefined,
      updatedAt: undefined,
      deactivated: false,
      metadata: {},
    };

    // Apply subsequent events
    for (let i = 1; i < log.events.length; i++) {
      const event = log.events[i];

      if (event.type === 'update') {
        const updateData = event.data as Record<string, unknown>;
        
        // Check if this is a migration event. Migration events carry a
        // sourceDid + layer; regular updates don't. (btco migrations no longer
        // carry targetDid in the signed data — see below.)
        if (updateData.sourceDid && updateData.layer) {
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
              // configured network. Fall back to the inscribing manager's network
              // only for legacy logs written before the network was recorded.
              const network = (updateData.network as string | undefined) ?? this.bitcoinManager.network;
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
        if (updateData.sourceDid && updateData.layer === 'btco') {
          excludedKeys.push('network');
        }
        for (const [key, value] of Object.entries(updateData)) {
          if (!excludedKeys.includes(key)) {
            state.metadata = state.metadata || {};
            state.metadata[key] = value;
          }
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
   * Gets the BitcoinManager instance used by this manager
   */
  get bitcoin(): BitcoinManager {
    return this.bitcoinManager;
  }
}
