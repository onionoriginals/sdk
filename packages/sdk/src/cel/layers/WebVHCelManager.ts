/**
 * WebVHCelManager - CEL Manager for did:webvh Layer
 * 
 * Manages migration of Originals assets to the did:webvh layer (Layer 1).
 * This layer provides HTTP-based witnessing for verifiable history.
 * 
 * The did:webvh (Web Verifiable History) method combines domain-based
 * resolution with cryptographic event logging for discoverable assets.
 * 
 * @see https://identity.foundation/didwebvh/
 */

import type { EventLog, ExternalReference, DataIntegrityProof, UpdateOptions, AssetState } from '../types';
import { updateEventLog } from '../algorithms/updateEventLog';
import { witnessEvent } from '../algorithms/witnessEvent';
import type { WitnessService } from '../witnesses/WitnessService';

/**
 * Configuration options for WebVHCelManager
 */
export interface WebVHCelConfig {
  /** The DID URL of the verification method for signing */
  verificationMethod?: string;
  /** The purpose of proofs (defaults to 'assertionMethod') */
  proofPurpose?: string;
}

/**
 * Migration data stored in the update event when migrating to webvh
 */
export interface WebVHMigrationData {
  /** The source DID from the previous layer */
  sourceDid: string;
  /** The new did:webvh DID */
  targetDid: string;
  /** The target layer */
  layer: 'webvh';
  /** The domain hosting the did:webvh */
  domain: string;
  /** ISO 8601 timestamp of migration */
  migratedAt: string;
}

/**
 * Signer function type that produces a DataIntegrityProof
 */
export type CelSigner = (data: unknown) => Promise<DataIntegrityProof>;

/**
 * WebVHCelManager - Manages CEL-based asset migration to did:webvh layer
 * 
 * The webvh layer is the first publication layer for Originals assets.
 * Assets at this layer:
 * - Have a did:webvh identifier based on a domain
 * - Can have HTTP-based witness attestations
 * - Are discoverable via web-based DID resolution
 * - Can be further migrated to did:btco layer
 * 
 * @example
 * ```typescript
 * const httpWitness = new HttpWitness('https://witness.example.com/api/attest');
 * const manager = new WebVHCelManager(
 *   async (data) => createEdDsaProof(data, privateKey),
 *   'example.com',
 *   [httpWitness]
 * );
 * 
 * const webvhLog = await manager.migrate(peerLog);
 * ```
 */
export class WebVHCelManager {
  private signer: CelSigner;
  private domain: string;
  private witnesses: WitnessService[];
  private config: WebVHCelConfig;

  /**
   * Creates a new WebVHCelManager instance
   * 
   * @param signer - Function that signs data and returns a DataIntegrityProof
   * @param domain - The domain for the did:webvh DID (e.g., 'example.com')
   * @param witnesses - Optional array of witness services for attestations
   * @param config - Optional configuration options
   */
  constructor(
    signer: CelSigner,
    domain: string,
    witnesses: WitnessService[] = [],
    config: WebVHCelConfig = {}
  ) {
    if (typeof signer !== 'function') {
      throw new Error('WebVHCelManager requires a signer function');
    }
    if (!domain || typeof domain !== 'string') {
      throw new Error('WebVHCelManager requires a valid domain string');
    }
    // Basic domain validation
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(domain) && !/^[a-zA-Z0-9]$/.test(domain)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }
    if (!Array.isArray(witnesses)) {
      throw new Error('witnesses must be an array');
    }
    
    this.signer = signer;
    this.domain = domain;
    this.witnesses = witnesses;
    this.config = {
      proofPurpose: 'assertionMethod',
      ...config,
    };
  }

  /**
   * Migrates a peer layer event log to the did:webvh layer
   * 
   * This method:
   * 1. Validates the input log (must have a create event with peer layer data)
   * 2. Generates a new did:webvh DID based on the domain
   * 3. Creates an update event with migration data
   * 4. Optionally adds witness proofs from configured witnesses
   * 5. Returns the updated EventLog
   * 
   * @param peerLog - The event log from the peer layer to migrate
   * @returns Promise resolving to an EventLog with the migration event appended
   * 
   * @throws Error if the log is empty, deactivated, or not from peer layer
   * @throws Error if signer produces invalid proof
   * @throws Error if witness service fails (if witnesses configured)
   */
  async migrate(peerLog: EventLog): Promise<EventLog> {
    // Validate input log
    if (!peerLog || !peerLog.events || peerLog.events.length === 0) {
      throw new Error('Cannot migrate an empty event log');
    }

    // Get the create event to extract source DID
    const createEvent = peerLog.events[0];
    if (createEvent.type !== 'create') {
      throw new Error('First event must be a create event');
    }

    // Extract source data
    const createData = createEvent.data as Record<string, unknown>;
    const sourceDid = createData.did as string;
    
    if (!sourceDid) {
      throw new Error('Create event must have a did field');
    }

    // Validate source is from peer layer
    const sourceLayer = createData.layer as string;
    if (sourceLayer && sourceLayer !== 'peer') {
      throw new Error(`Cannot migrate from ${sourceLayer} layer to webvh layer. Expected peer layer.`);
    }

    // Check if log is already deactivated
    const lastEvent = peerLog.events[peerLog.events.length - 1];
    if (lastEvent.type === 'deactivate') {
      throw new Error('Cannot migrate a deactivated event log');
    }

    // Generate did:webvh DID
    const targetDid = this.generateWebVHDid(sourceDid);

    // Prepare migration data
    const migrationData: WebVHMigrationData = {
      sourceDid,
      targetDid,
      layer: 'webvh',
      domain: this.domain,
      migratedAt: new Date().toISOString(),
    };

    // Build update options
    const updateOptions: UpdateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || `${targetDid}#key-0`,
      proofPurpose: this.config.proofPurpose,
    };

    // Create the update event with migration data
    let updatedLog = await updateEventLog(peerLog, migrationData, updateOptions);

    // Add witness proofs if witnesses are configured
    if (this.witnesses.length > 0) {
      // Get the last event (the migration event we just added)
      const lastEventIndex = updatedLog.events.length - 1;
      let witnessedEvent = updatedLog.events[lastEventIndex];

      // Add witness proofs from each configured witness
      for (const witness of this.witnesses) {
        witnessedEvent = await witnessEvent(witnessedEvent, witness);
      }

      // Replace the last event with the witnessed version
      updatedLog = {
        ...updatedLog,
        events: [
          ...updatedLog.events.slice(0, lastEventIndex),
          witnessedEvent,
        ],
      };
    }

    return updatedLog;
  }

  /**
   * Generates a did:webvh DID for this domain
   * 
   * The did:webvh format is: did:webvh:{domain}:{id}
   * where {id} is derived from the source DID to maintain linkage.
   * 
   * @param sourceDid - The source DID to derive the webvh DID from
   * @returns A did:webvh string
   */
  private generateWebVHDid(sourceDid: string): string {
    // Extract a stable identifier from the source DID
    // For did:peer, extract the key portion after the method
    let idPart: string;
    
    if (sourceDid.startsWith('did:peer:')) {
      // For peer DIDs, use a hash-derived portion
      // did:peer:4zQm... -> use the multibase portion
      const peerPart = sourceDid.replace('did:peer:', '');
      // Take first 32 chars of the peer DID identifier for brevity
      idPart = peerPart.substring(0, Math.min(32, peerPart.length));
    } else if (sourceDid.startsWith('did:key:')) {
      // For key DIDs, extract the key portion
      idPart = sourceDid.replace('did:key:', '').substring(0, 32);
    } else {
      // For other DIDs, create a hash-based identifier
      idPart = this.hashIdentifier(sourceDid);
    }

    // Sanitize for URL safety (replace invalid chars)
    idPart = idPart.replace(/[^a-zA-Z0-9]/g, '');

    return `did:webvh:${this.domain}:${idPart}`;
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
          state.metadata.domain = updateData.domain;
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
          if (!['name', 'resources', 'updatedAt', 'did', 'layer', 'creator', 'createdAt', 'sourceDid', 'targetDid', 'domain', 'migratedAt'].includes(key)) {
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
   * Gets the domain this manager is configured for
   */
  get domainName(): string {
    return this.domain;
  }

  /**
   * Gets the number of configured witnesses
   */
  get witnessCount(): number {
    return this.witnesses.length;
  }
}
