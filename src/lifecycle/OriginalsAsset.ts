import { 
  AssetResource, 
  DIDDocument, 
  VerifiableCredential, 
  LayerType 
} from '../types';
import { validateDIDDocument, validateCredential, hashResource } from '../utils/validation';
import { CredentialManager } from '../vc/CredentialManager';
import { DIDManager } from '../did/DIDManager';
import { EventEmitter } from '../events/EventEmitter';
import type { EventHandler, EventTypeMap } from '../events/types';

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
  transfers: Array<{
    from: string;
    to: string;
    timestamp: string;
    transactionId: string;
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

  constructor(
    resources: AssetResource[],
    did: DIDDocument,
    credentials: VerifiableCredential[]
  ) {
    this.id = did.id;
    this.resources = resources;
    this.did = did;
    this.credentials = credentials;
    this.currentLayer = this.determineCurrentLayer(did.id);
    this.provenance = {
      createdAt: new Date().toISOString(),
      creator: did.id,
      migrations: [],
      transfers: []
    };
    this.eventEmitter = new EventEmitter();
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
      'did:peer': ['did:webvh', 'did:btco'],
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

  async recordTransfer(from: string, to: string, transactionId: string): Promise<void> {
    this.provenance.transfers.push({
      from,
      to,
      timestamp: new Date().toISOString(),
      transactionId
    });
    this.provenance.txid = transactionId;
    
    // Emit transfer event and await handlers
    await this.eventEmitter.emit({
      type: 'asset:transferred',
      timestamp: new Date().toISOString(),
      asset: {
        id: this.id,
        layer: this.currentLayer
      },
      from,
      to,
      transactionId
    });
  }

  async verify(deps?: {
    didManager?: DIDManager;
    credentialManager?: CredentialManager;
    fetch?: (url: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
  }): Promise<boolean> {
    try {
      // 1) DID Document validation (structure + supported method via validateDID)
      if (!validateDIDDocument(this.did)) {
        return false;
      }

      // 2) Resources integrity
      for (const res of this.resources) {
        if (!res || typeof res.id !== 'string' || typeof res.type !== 'string' || typeof res.contentType !== 'string') {
          return false;
        }
        if (typeof res.hash !== 'string' || !/[0-9a-f]+/i.test(res.hash)) {
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

        // If URL present and fetch is provided, attempt to fetch and hash
        if (typeof res.url === 'string' && deps?.fetch) {
          try {
            const response = await deps.fetch(res.url);
            const buf = Buffer.from(await response.arrayBuffer());
            const computed = hashResource(buf);
            const expected = (res.hash || '').toLowerCase();
            if (computed.toLowerCase() !== expected) {
              return false;
            }
          } catch {
            // On fetch error, treat as unverifiable but do not fail the entire asset
            // Fall back to structural validation only
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

  private determineCurrentLayer(didId: string): LayerType {
    if (didId.startsWith('did:peer:')) return 'did:peer';
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


