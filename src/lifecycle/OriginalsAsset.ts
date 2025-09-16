import { 
  AssetResource, 
  DIDDocument, 
  VerifiableCredential, 
  LayerType 
} from '../types';

export interface ProvenanceChain {
  createdAt: string;
  creator: string;
  migrations: Array<{
    from: LayerType;
    to: LayerType;
    timestamp: string;
    transactionId?: string;
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
  }

  async migrate(toLayer: LayerType): Promise<void> {
    // Handle migration between layers
    const validTransitions: Record<LayerType, LayerType[]> = {
      'did:peer': ['did:webvh', 'did:btco'],
      'did:webvh': ['did:btco'],
      'did:btco': [] // No further migrations possible
    };

    if (!validTransitions[this.currentLayer].includes(toLayer)) {
      throw new Error(`Invalid migration from ${this.currentLayer} to ${toLayer}`);
    }

    throw new Error('Not implemented');
  }

  getProvenance(): ProvenanceChain {
    // Return full provenance chain from credentials
    throw new Error('Not implemented');
  }

  async verify(): Promise<boolean> {
    // Verify asset integrity across all layers
    throw new Error('Not implemented');
  }

  private determineCurrentLayer(didId: string): LayerType {
    if (didId.startsWith('did:peer:')) return 'did:peer';
    if (didId.startsWith('did:webvh:')) return 'did:webvh';
    if (didId.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unknown DID method');
  }
}


