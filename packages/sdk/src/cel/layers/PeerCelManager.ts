/**
 * PeerCelManager - CEL Manager for did:peer Layer
 * 
 * Creates and manages Originals assets in the did:peer layer (Layer 0).
 * This is the initial layer for creating new assets with local control.
 * No witnesses are required at this layer.
 * 
 * @see https://identity.foundation/peer-did-method-spec/
 */

import type { EventLog, ExternalReference, DataIntegrityProof, CreateOptions } from '../types';
import { createEventLog } from '../algorithms/createEventLog';

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
 * Asset data stored in the create event
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
 * PeerCelManager - Manages CEL-based assets in the did:peer layer
 * 
 * The peer layer is the initial layer for creating new Originals assets.
 * Assets at this layer:
 * - Have a did:peer identifier
 * - Are controlled by the creator's key pair
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
 * const log = await manager.create('My Asset', [
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
   * Creates a new asset with a did:peer identifier and CEL event log
   * 
   * This method:
   * 1. Generates a new did:peer DID using the verification method from config
   * 2. Creates a "create" event with the asset data
   * 3. Signs the event using the provided signer
   * 4. Returns an EventLog containing the initial create event
   * 
   * @param name - Human-readable name for the asset
   * @param resources - External resources associated with the asset
   * @returns Promise resolving to an EventLog with the create event
   * 
   * @throws Error if signer produces invalid proof
   * @throws Error if DID generation fails
   */
  async create(name: string, resources: ExternalReference[]): Promise<EventLog> {
    // Validate inputs
    if (!name || typeof name !== 'string') {
      throw new Error('Asset name is required and must be a string');
    }
    if (!Array.isArray(resources)) {
      throw new Error('Resources must be an array');
    }

    // Generate did:peer DID for this asset
    const did = await this.generatePeerDid();

    // Prepare asset data for the create event
    const assetData: PeerAssetData = {
      name,
      did,
      layer: 'peer',
      resources,
      creator: did, // Creator is the same as asset DID for peer layer
      createdAt: new Date().toISOString(),
    };

    // Build create options
    const createOptions: CreateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || `${did}#key-0`,
      proofPurpose: this.config.proofPurpose,
    };

    // Create the event log with a create event
    const eventLog = await createEventLog(assetData, createOptions);

    return eventLog;
  }

  /**
   * Generates a new did:peer DID (numalgo 4 - long form)
   * 
   * Uses @aviarytech/did-peer library to create a numalgo 4 DID
   * which embeds the full DID document for self-contained resolution.
   * 
   * @returns Promise resolving to a did:peer string
   */
  private async generatePeerDid(): Promise<string> {
    // Dynamically import did-peer library
    let didPeerMod: any;
    try {
      didPeerMod = await import('@aviarytech/did-peer');
    } catch (err) {
      throw new Error(
        'Failed to import @aviarytech/did-peer. Make sure it is installed: npm install @aviarytech/did-peer'
      );
    }

    // If we have a verification method with a public key, use it
    // Otherwise, generate a placeholder DID using a random key
    // In production, the signer's verification method should be used
    
    // For did:peer numalgo 4, we need a verification method
    // The verification method should come from the config or be derived from the signer
    
    // Generate a DID using numalgo 4 (long-form with embedded DID document)
    // We'll use a simple verification method structure
    let publicKeyMultibase: string;
    
    // If verificationMethod is provided and contains a key reference, extract it
    if (this.config.verificationMethod && this.config.verificationMethod.includes('did:key:')) {
      // Extract the public key from did:key format
      const keyMatch = this.config.verificationMethod.match(/did:key:(z[a-zA-Z0-9]+)/);
      publicKeyMultibase = keyMatch ? keyMatch[1] : await this.generateRandomPublicKey();
    } else if (this.config.verificationMethod && this.config.verificationMethod.includes('#')) {
      // If it's a fragment reference, we need to generate a key
      publicKeyMultibase = await this.generateRandomPublicKey();
    } else {
      // Generate a random public key for the DID
      publicKeyMultibase = await this.generateRandomPublicKey();
    }

    // Create did:peer using numalgo 4
    const did: string = await didPeerMod.createNumAlgo4(
      [
        {
          type: 'Multikey',
          publicKeyMultibase,
        }
      ],
      undefined, // services
      undefined  // alsoKnownAs
    );

    return did;
  }

  /**
   * Generates a random Ed25519 public key for DID creation
   * 
   * @returns Promise resolving to a multibase-encoded public key
   */
  private async generateRandomPublicKey(): Promise<string> {
    // Use @noble/ed25519 for key generation
    const ed25519 = await import('@noble/ed25519');
    const privateKeyBytes = ed25519.utils.randomPrivateKey();
    const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
    
    // Import multikey encoder
    const { multikey } = await import('../../crypto/Multikey');
    return multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519');
  }
}
