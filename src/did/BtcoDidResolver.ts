import type { DIDDocument } from '../types/did';

export interface BtcoInscriptionData {
  inscriptionId: string;
  content: string;
  metadata: any;
  contentUrl?: string;
  contentType?: string;
  isValidDid?: boolean;
  didDocument?: DIDDocument | null;
  error?: string;
}

export interface BtcoDidResolutionResult {
  didDocument: DIDDocument | null;
  inscriptions?: BtcoInscriptionData[];
  resolutionMetadata: {
    contentType?: string;
    error?: string;
    message?: string;
    inscriptionId?: string;
    satNumber?: string;
    network?: string;
    totalInscriptions?: number;
  };
  didDocumentMetadata: {
    created?: string;
    updated?: string;
    deactivated?: boolean;
    inscriptionId?: string;
    network?: string;
  };
}

export interface ResourceProviderLike {
  getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }>;
  resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }>;
  getMetadata(inscriptionId: string): Promise<any>;
}

export interface BtcoDidResolutionOptions {
  provider?: ResourceProviderLike;
}

export class BtcoDidResolver {
  private readonly options: BtcoDidResolutionOptions;

  constructor(options: BtcoDidResolutionOptions = {}) {
    this.options = options;
  }

  private parseBtcoDid(did: string): { satNumber: string; path?: string; network: string } | null {
    const regex = /^did:btco(?::(test|sig))?:([0-9]+)(?:\/(.+))?$/;
    const match = did.match(regex);
    if (!match) return null;
    const [, networkSuffix, satNumber, path] = match;
    const network = networkSuffix || 'mainnet';
    return { satNumber, path, network };
  }

  private getDidPrefix(network: string): string {
    switch (network) {
      case 'test':
      case 'testnet':
        return 'did:btco:test';
      case 'sig':
      case 'signet':
        return 'did:btco:sig';
      default:
        return 'did:btco';
    }
  }

  async resolve(did: string, options: BtcoDidResolutionOptions = {}): Promise<BtcoDidResolutionResult> {
    const parsed = this.parseBtcoDid(did);
    if (!parsed) {
      return this.createErrorResult('invalidDid', `Invalid BTCO DID format: ${did}`);
    }

    const { satNumber, network } = parsed;
    const provider = options.provider || this.options.provider;
    if (!provider) {
      return this.createErrorResult('noProvider', 'No provider supplied');
    }

    let inscriptionIds: string[] = [];
    try {
      const satInfo = await provider.getSatInfo(satNumber);
      inscriptionIds = satInfo?.inscription_ids || [];
    } catch (e: any) {
      return this.createErrorResult('notFound', `Failed to retrieve inscriptions for satoshi ${satNumber}: ${e?.message || String(e)}`);
    }

    if (inscriptionIds.length === 0) {
      return this.createErrorResult('notFound', `No inscriptions found on satoshi ${satNumber}`);
    }

    const expectedDid = `${this.getDidPrefix(network)}:${satNumber}`;
    const didPattern = new RegExp(`^(?:BTCO DID: )?(${expectedDid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');

    const inscriptionDataList: BtcoInscriptionData[] = [];

    for (const inscriptionId of inscriptionIds) {
      const inscriptionData: BtcoInscriptionData = {
        inscriptionId,
        content: '',
        metadata: null
      };

      try {
        const inscription = await provider.resolveInscription(inscriptionId);
        if (!inscription) {
          inscriptionData.error = `Inscription ${inscriptionId} not found`;
          inscriptionDataList.push(inscriptionData);
          continue;
        }

        inscriptionData.contentUrl = inscription.content_url;
        inscriptionData.contentType = inscription.content_type;

        try {
          const response = await fetch(inscription.content_url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          inscriptionData.content = await response.text();
        } catch (err: any) {
          inscriptionData.error = `Failed to fetch content: ${err?.message || String(err)}`;
          inscriptionDataList.push(inscriptionData);
          continue;
        }

        try {
          inscriptionData.metadata = await provider.getMetadata(inscriptionId);
        } catch (err) {
          inscriptionData.metadata = null;
        }

        inscriptionData.isValidDid = didPattern.test(inscriptionData.content);

        if (inscriptionData.isValidDid && inscriptionData.metadata) {
          const didDocument = inscriptionData.metadata as DIDDocument;
          if (this.isValidDidDocument(didDocument) && didDocument.id === expectedDid) {
            inscriptionData.didDocument = didDocument;
          } else {
            inscriptionData.error = 'Invalid DID document structure or mismatched ID';
          }
        }

        if (inscriptionData.content.includes('🔥')) {
          inscriptionData.didDocument = null;
          /* istanbul ignore next */
          if (!inscriptionData.error) {
            inscriptionData.error = 'DID has been deactivated';
          }
        }
      } catch (err: any) {
        inscriptionData.error = `Failed to process inscription: ${err?.message || String(err)}`;
      }

      inscriptionDataList.push(inscriptionData);
    }

    let latestValidDidDocument: DIDDocument | null = null;
    let latestInscriptionId: string | undefined;
    for (let i = inscriptionDataList.length - 1; i >= 0; i--) {
      const data = inscriptionDataList[i];
      if (data.didDocument && !data.error) {
        latestValidDidDocument = data.didDocument;
        latestInscriptionId = data.inscriptionId;
        break;
      }
    }

    return {
      didDocument: latestValidDidDocument,
      inscriptions: inscriptionDataList,
      resolutionMetadata: {
        inscriptionId: latestInscriptionId,
        satNumber,
        network,
        totalInscriptions: inscriptionDataList.length
      },
      didDocumentMetadata: {
        inscriptionId: latestInscriptionId,
        network
      }
    };
  }

  private isValidDidDocument(doc: any): doc is DIDDocument {
    /* istanbul ignore next */
    if (!doc || typeof doc !== 'object') return false;
    /* istanbul ignore next */
    if (!doc.id || typeof doc.id !== 'string') return false;
    /* istanbul ignore next */
    if (!doc['@context']) return false;
    const contexts = Array.isArray(doc['@context']) ? doc['@context'] : [doc['@context']];
    if (!contexts.includes('https://www.w3.org/ns/did/v1') && !contexts.includes('https://w3id.org/did/v1')) {
      return false;
    }
    /* istanbul ignore next */
    if (doc.verificationMethod && !Array.isArray(doc.verificationMethod)) return false;
    /* istanbul ignore next */
    if (doc.authentication && !Array.isArray(doc.authentication)) return false;
    return true;
  }

  private createErrorResult(error: string, message: string): BtcoDidResolutionResult {
    return {
      didDocument: null,
      resolutionMetadata: { error, message },
      didDocumentMetadata: {}
    };
  }
}

