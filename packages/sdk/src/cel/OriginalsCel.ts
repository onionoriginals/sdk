/**
 * OriginalsCel - Unified SDK Entry Point for CEL Operations
 * 
 * Provides a single, simplified interface for all Cryptographic Event Log
 * operations across all layers (peer, webvh, btco).
 * 
 * This class delegates to the appropriate layer manager based on
 * the configured layer and the current state of the event log.
 * 
 * @example
 * ```typescript
 * // Create a peer-layer asset
 * const cel = new OriginalsCel({
 *   layer: 'peer',
 *   signer: async (data) => createEdDsaProof(data, privateKey),
 * });
 * 
 * const log = await cel.create('My Asset', [
 *   { digestMultibase: 'uXYZ...', mediaType: 'image/png' }
 * ]);
 * 
 * // Update the asset
 * const updated = await cel.update(log, { description: 'Updated' });
 * 
 * // Verify the log
 * const result = await cel.verify(updated);
 * 
 * // Migrate to webvh layer
 * const migrated = await cel.migrate(updated, 'webvh');
 * ```
 */

import type {
  EventLog,
  ExternalReference,
  VerificationResult,
  VerifyOptions,
  AssetState
} from './types';
import { PeerCelManager, type PeerCelConfig, type CelSigner } from './layers/PeerCelManager';
import { WebVHCelManager, type WebVHCelConfig } from './layers/WebVHCelManager';
import { BtcoCelManager, type BtcoCelConfig } from './layers/BtcoCelManager';
import { verifyEventLog } from './algorithms/verifyEventLog';
import type { WitnessService } from './witnesses/WitnessService';
import type { BitcoinManager } from '../bitcoin/BitcoinManager';

/**
 * Supported layer types
 */
export type CelLayer = 'peer' | 'webvh' | 'btco';

// Re-export CelSigner for convenience
export type { CelSigner };

/**
 * Configuration options for OriginalsCel
 */
export interface OriginalsCelConfig {
  /** Configuration for peer layer operations */
  peer?: PeerCelConfig;
  
  /** Configuration for webvh layer operations */
  webvh?: {
    /** The domain for the did:webvh DID (required for webvh operations) */
    domain?: string;
    /** Optional witness services for HTTP attestations */
    witnesses?: WitnessService[];
  } & WebVHCelConfig;
  
  /** Configuration for btco layer operations */
  btco?: {
    /** BitcoinManager instance (required for btco operations) */
    bitcoinManager?: BitcoinManager;
  } & BtcoCelConfig;
}

/**
 * Options for creating an OriginalsCel instance
 */
export interface OriginalsCelOptions {
  /** The target layer for operations */
  layer: CelLayer;
  /** Signer function that produces DataIntegrityProofs */
  signer: CelSigner;
  /** Optional layer-specific configuration */
  config?: OriginalsCelConfig;
}

/**
 * OriginalsCel - Unified SDK for Cryptographic Event Log operations
 * 
 * Provides a consistent API for creating, updating, verifying, and migrating
 * assets across all supported layers (peer, webvh, btco).
 */
export class OriginalsCel {
  private layer: CelLayer;
  private signer: CelSigner;
  private config: OriginalsCelConfig;
  
  // Layer managers (created lazily)
  private _peerManager?: PeerCelManager;
  private _webvhManager?: WebVHCelManager;
  private _btcoManager?: BtcoCelManager;

  /**
   * Creates a new OriginalsCel instance
   * 
   * @param options - Configuration options
   * @param options.layer - The target layer for operations (peer, webvh, btco)
   * @param options.signer - Function that signs data and returns a DataIntegrityProof
   * @param options.config - Optional layer-specific configuration
   * 
   * @throws Error if signer is not a function
   * @throws Error if layer is invalid
   */
  constructor(options: OriginalsCelOptions) {
    if (typeof options.signer !== 'function') {
      throw new Error('OriginalsCel requires a signer function');
    }
    
    const validLayers: CelLayer[] = ['peer', 'webvh', 'btco'];
    if (!validLayers.includes(options.layer)) {
      throw new Error(`Invalid layer: ${options.layer}. Must be one of: ${validLayers.join(', ')}`);
    }
    
    this.layer = options.layer;
    this.signer = options.signer;
    this.config = options.config || {};
  }

  /**
   * Gets or creates the PeerCelManager instance
   */
  private get peerManager(): PeerCelManager {
    if (!this._peerManager) {
      this._peerManager = new PeerCelManager(this.signer, this.config.peer);
    }
    return this._peerManager;
  }

  /**
   * Gets or creates the WebVHCelManager instance
   * 
   * @throws Error if domain is not configured for webvh operations
   */
  private getWebVHManager(domain?: string): WebVHCelManager {
    const webvhDomain = domain || this.config.webvh?.domain;
    
    if (!webvhDomain) {
      throw new Error('WebVH operations require a domain. Provide it in config.webvh.domain');
    }
    
    // Always create a new instance with the current domain to support different domains
    return new WebVHCelManager(
      this.signer,
      webvhDomain,
      this.config.webvh?.witnesses || [],
      this.config.webvh
    );
  }

  /**
   * Gets or creates the BtcoCelManager instance
   * 
   * @throws Error if BitcoinManager is not configured for btco operations
   */
  private get btcoManager(): BtcoCelManager {
    if (!this._btcoManager) {
      const bitcoinManager = this.config.btco?.bitcoinManager;
      
      if (!bitcoinManager) {
        throw new Error('BTCO operations require a BitcoinManager. Provide it in config.btco.bitcoinManager');
      }
      
      this._btcoManager = new BtcoCelManager(
        this.signer,
        bitcoinManager,
        this.config.btco
      );
    }
    return this._btcoManager;
  }

  /**
   * Creates a new asset with a CEL event log
   * 
   * This method creates an asset at the configured layer. Note that
   * new assets can only be created at the peer layer - for other layers,
   * create at peer first and then migrate.
   * 
   * @param name - Human-readable name for the asset
   * @param resources - External resources associated with the asset
   * @returns Promise resolving to an EventLog with the create event
   * 
   * @throws Error if signer produces invalid proof
   * @throws Error if trying to create at non-peer layer
   * 
   * @example
   * ```typescript
   * const log = await cel.create('My Asset', [
   *   createExternalReference(imageData, 'image/png')
   * ]);
   * ```
   */
  async create(name: string, resources: ExternalReference[]): Promise<EventLog> {
    // Assets can only be created at the peer layer
    // Other layers require migration from peer
    if (this.layer !== 'peer') {
      throw new Error(
        `Cannot create assets at ${this.layer} layer directly. ` +
        `Create at peer layer first, then use migrate() to move to ${this.layer}.`
      );
    }
    
    return this.peerManager.create(name, resources);
  }

  /**
   * Updates an existing event log by appending an update event
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
   * const updated = await cel.update(log, {
   *   description: 'Updated description',
   *   tags: ['art', 'digital']
   * });
   * ```
   */
  async update(log: EventLog, data: unknown): Promise<EventLog> {
    // Determine the current layer of the log
    const currentLayer = this.getCurrentLayer(log);
    
    // Use the appropriate manager based on current layer
    switch (currentLayer) {
      case 'peer':
        return this.peerManager.update(log, data);
      case 'webvh': {
        // For webvh, we need to use the webvh manager
        // Get domain from the log if possible
        const webvhDomain = this.extractDomainFromLog(log);
        return this.getWebVHManager(webvhDomain).migrate(log).then(
          // webvh manager doesn't have update, use peer manager's algorithm
          () => this.peerManager.update(log, data)
        );
      }
      case 'btco':
        // For btco, updates use the same underlying algorithm
        return this.peerManager.update(log, data);
      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = currentLayer;
        throw new Error(`Unknown layer: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Verifies all proofs and hash chain integrity in an event log
   * 
   * This method verifies:
   * - Each event has at least one proof
   * - Each proof is structurally valid
   * - The hash chain is intact (each event links to previous)
   * 
   * @param log - The event log to verify
   * @param options - Optional verification options
   * @returns Promise resolving to VerificationResult with detailed status
   * 
   * @example
   * ```typescript
   * const result = await cel.verify(log);
   * if (result.verified) {
   *   console.log('Log is valid!');
   * } else {
   *   console.error('Verification failed:', result.errors);
   * }
   * ```
   */
  async verify(log: EventLog, options?: VerifyOptions): Promise<VerificationResult> {
    return verifyEventLog(log, options);
  }

  /**
   * Migrates an event log to a target layer
   * 
   * Migration adds an update event with migration data and (optionally)
   * witness proofs. The valid migration paths are:
   * - peer → webvh
   * - webvh → btco
   * - peer → btco (requires intermediate webvh migration)
   * 
   * @param log - The event log to migrate
   * @param targetLayer - The layer to migrate to
   * @param options - Optional migration options (e.g., domain for webvh)
   * @returns Promise resolving to the migrated EventLog
   * 
   * @throws Error if migration path is invalid
   * @throws Error if required config is missing for target layer
   * 
   * @example
   * ```typescript
   * // Migrate peer to webvh
   * const webvhLog = await cel.migrate(peerLog, 'webvh', {
   *   domain: 'example.com'
   * });
   * 
   * // Migrate webvh to btco
   * const btcoLog = await cel.migrate(webvhLog, 'btco');
   * ```
   */
  async migrate(
    log: EventLog, 
    targetLayer: CelLayer,
    options?: { domain?: string }
  ): Promise<EventLog> {
    const currentLayer = this.getCurrentLayer(log);
    
    // Validate migration path
    if (currentLayer === targetLayer) {
      throw new Error(`Log is already at ${targetLayer} layer`);
    }
    
    if (currentLayer === 'btco') {
      throw new Error('Cannot migrate from btco layer - it is the final layer');
    }
    
    // Perform migration based on current and target layers
    switch (targetLayer) {
      case 'peer':
        throw new Error('Cannot migrate to peer layer - it is the initial layer');

      case 'webvh': {
        if (currentLayer !== 'peer') {
          throw new Error(`Invalid migration: ${currentLayer} → webvh. Can only migrate peer → webvh.`);
        }
        const domain = options?.domain || this.config.webvh?.domain;
        return this.getWebVHManager(domain).migrate(log);
      }

      case 'btco': {
        if (currentLayer === 'peer') {
          // Need to do two-step migration: peer → webvh → btco
          throw new Error(
            'Cannot migrate directly from peer to btco. ' +
            'Migrate to webvh first, then to btco.'
          );
        }
        if (currentLayer !== 'webvh') {
          throw new Error(`Invalid migration: ${String(currentLayer)} → btco. Can only migrate webvh → btco.`);
        }
        return this.btcoManager.migrate(log);
      }

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = targetLayer;
        throw new Error(`Unknown target layer: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Derives the current asset state by replaying all events in the log
   * 
   * @param log - The event log to derive state from
   * @returns The current AssetState
   * 
   * @example
   * ```typescript
   * const state = cel.getCurrentState(log);
   * console.log(state.name);        // Asset name
   * console.log(state.layer);       // Current layer
   * console.log(state.deactivated); // Whether deactivated
   * ```
   */
  getCurrentState(log: EventLog): AssetState {
    // Determine current layer and use appropriate manager
    const currentLayer = this.getCurrentLayer(log);

    switch (currentLayer) {
      case 'peer':
        return this.peerManager.getCurrentState(log);
      case 'webvh': {
        // WebVH manager also handles state derivation correctly
        const domain = this.extractDomainFromLog(log) || 'unknown.com';
        return this.getWebVHManager(domain).getCurrentState(log);
      }
      case 'btco':
        return this.btcoManager.getCurrentState(log);
      default:
        // Fallback to peer manager which handles all event types
        return this.peerManager.getCurrentState(log);
    }
  }

  /**
   * Determines the current layer of an event log by examining its events
   * 
   * @param log - The event log to examine
   * @returns The current layer of the log
   */
  private getCurrentLayer(log: EventLog): CelLayer {
    if (!log || !log.events || log.events.length === 0) {
      return 'peer'; // Default for empty logs
    }
    
    let currentLayer: CelLayer = 'peer';
    
    for (const event of log.events) {
      const eventData = event.data as Record<string, unknown>;
      
      if (event.type === 'create') {
        currentLayer = (eventData.layer as CelLayer) || 'peer';
      } else if (event.type === 'update' && eventData.targetDid && eventData.layer) {
        // This is a migration event
        currentLayer = eventData.layer as CelLayer;
      }
    }
    
    return currentLayer;
  }

  /**
   * Extracts the domain from a webvh log's migration event
   * 
   * @param log - The event log to examine
   * @returns The domain if found, undefined otherwise
   */
  private extractDomainFromLog(log: EventLog): string | undefined {
    if (!log || !log.events) {
      return undefined;
    }
    
    for (const event of log.events) {
      const eventData = event.data as Record<string, unknown>;
      if (eventData.domain) {
        return eventData.domain as string;
      }
    }
    
    return undefined;
  }

  /**
   * Gets the configured layer for this instance
   */
  get currentLayer(): CelLayer {
    return this.layer;
  }
}
