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
  /** The new did:btco DID */
  targetDid: string;
  /** The target layer */
  layer: 'btco';
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
      } else if (event.type === 'update' && eventData.targetDid && eventData.layer) {
        // This is a migration event
        currentDid = eventData.targetDid as string;
        currentLayer = eventData.layer as string;
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
    // verification. The Bitcoin txid/inscriptionId cannot be known before the
    // inscription anyway (chicken-and-egg), so they are NOT part of the signed
    // data — they live in the bitcoin witness proof, which is added after
    // signing and excluded from the chain digest. targetDid is derived
    // deterministically from the source DID so it is known at signing time.
    const migrationData: BtcoMigrationData = {
      sourceDid: currentDid,
      targetDid: this.generateBtcoDid(currentDid),
      layer: 'btco',
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
   * Generates a did:btco DID fallback from source DID
   * 
   * @param sourceDid - The source DID to derive from
   * @returns A did:btco string
   */
  private generateBtcoDid(sourceDid: string): string {
    // Extract identifier portion from source DID
    let idPart: string;
    
    if (sourceDid.startsWith('did:webvh:')) {
      // For webvh DIDs, extract the identifier after domain
      const parts = sourceDid.split(':');
      idPart = parts.length > 3 ? parts.slice(3).join('') : this.hashIdentifier(sourceDid);
    } else {
      // For other DIDs, create a hash-based identifier
      idPart = this.hashIdentifier(sourceDid);
    }

    // Sanitize for DID (alphanumeric only)
    idPart = idPart.replace(/[^a-zA-Z0-9]/g, '').substring(0, 64);

    return `did:btco:${idPart}`;
  }

  /**
   * Creates a URL-safe hash-based identifier from a string
   */
  private hashIdentifier(input: string): string {
    // Simple hash for identifier generation (not cryptographic)
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
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
        
        // Check if this is a migration event
        if (updateData.targetDid && updateData.layer) {
          // Migration event - update DID and layer
          state.did = updateData.targetDid as string;
          state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
          state.updatedAt = updateData.migratedAt as string;
          
          // Store migration info in metadata
          state.metadata = state.metadata || {};
          state.metadata.sourceDid = updateData.sourceDid;
          
          // Store Bitcoin-specific metadata for btco layer. txid/inscriptionId
          // are NOT part of the signed event data (they can't be known before
          // inscription); they are read from the bitcoin witness proof.
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
          } else if (updateData.domain) {
            state.metadata.domain = updateData.domain;
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
        
        // Store other fields in metadata
        for (const [key, value] of Object.entries(updateData)) {
          if (!['name', 'resources', 'updatedAt', 'did', 'layer', 'creator', 'createdAt', 'sourceDid', 'targetDid', 'domain', 'migratedAt', 'txid', 'inscriptionId'].includes(key)) {
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
