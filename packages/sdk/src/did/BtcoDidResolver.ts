import type { DIDDocument } from '../types/did';

export interface BtcoInscriptionData {
  inscriptionId: string;
  content: string;
  metadata: Record<string, unknown> | null;
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
  getMetadata(inscriptionId: string): Promise<Record<string, unknown> | null>;
}

export interface BtcoDidResolutionOptions {
  provider?: ResourceProviderLike;
  fetchFn?: (url: string) => Promise<Response>;
  timeout?: number;
  accept?: string;
}

export class BtcoDidResolver {
  private readonly options: BtcoDidResolutionOptions;

  constructor(options: BtcoDidResolutionOptions = {}) {
    this.options = options;
  }

  private parseBtcoDid(did: string): { satNumber: string; path?: string; network: string } | null {
    const regex = /^did:btco(?::(reg|sig))?:([0-9]+)(?:\/(.+))?$/;
    const match = did.match(regex);
    if (!match) return null;
    const [, networkSuffix, satNumber, path] = match;
    const network = networkSuffix || 'mainnet';
    return { satNumber, path, network };
  }

  private getDidPrefix(network: string): string {
    switch (network) {
      case 'reg':
      case 'regtest':
        return 'did:btco:reg';
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

    const { satNumber, network, path } = parsed;

    const requestedAccept = options.accept || this.options.accept;
    if (requestedAccept && !this.isSupportedRepresentation(requestedAccept)) {
      return this.createErrorResult('representationNotSupported', `Unsupported representation: ${requestedAccept}`);
    }

    if (path) {
      return this.createErrorResult('representationNotSupported', `DID URL dereferencing is not supported for BTCO paths: /${path}`);
    }

    const provider = options.provider || this.options.provider;
    if (!provider) {
      return this.createErrorResult('notFound', 'No provider supplied');
    }

    let inscriptionIds: string[] = [];
    try {
      const satInfo = await provider.getSatInfo(satNumber);
      inscriptionIds = satInfo?.inscription_ids || [];
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return this.createErrorResult('notFound', `Failed to retrieve inscriptions for satoshi ${satNumber}: ${message}`);
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
          // Use configurable fetch function or default to global fetch
          const fetchFn = options.fetchFn || this.options.fetchFn || fetch;
          const timeout = options.timeout || this.options.timeout || 10000; // 10 second default

          // Create abort controller for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          try {
            const response = await fetchFn(inscription.content_url);
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            inscriptionData.content = await response.text();
          } finally {
            clearTimeout(timeoutId);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          inscriptionData.error = `Failed to fetch content: ${message}`;
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
          const didDocument = inscriptionData.metadata as unknown as DIDDocument;
          if (this.isValidDidDocument(didDocument) && didDocument.id === expectedDid) {
            inscriptionData.didDocument = didDocument;
          } else {
            inscriptionData.error = 'Invalid DID document structure or mismatched ID';
          }
        }

        if (inscriptionData.content.includes('🔥')) {
          inscriptionData.didDocument = null;
          if (!inscriptionData.error) {
            inscriptionData.error = 'DID has been deactivated';
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        inscriptionData.error = `Failed to process inscription: ${message}`;
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

  private isValidDidDocument(doc: unknown): doc is DIDDocument {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (!d.id || typeof d.id !== 'string') return false;
    if (!d['@context']) return false;
    const contexts = Array.isArray(d['@context']) ? d['@context'] : [d['@context']];
    if (!contexts.includes('https://www.w3.org/ns/did/v1') && !contexts.includes('https://w3id.org/did/v1')) {
      return false;
    }
    if (d.verificationMethod && !Array.isArray(d.verificationMethod)) return false;
    if (d.authentication && !Array.isArray(d.authentication)) return false;
    return true;
  }

  private isSupportedRepresentation(accept: string): boolean {
    const normalized = accept.toLowerCase();
    return normalized.includes('application/did+json') || normalized.includes('application/json') || normalized.includes('*/*');
  }

  private createErrorResult(error: string, message: string): BtcoDidResolutionResult {
    return {
      didDocument: null,
      resolutionMetadata: { error, message },
      didDocumentMetadata: {}
    };
  }
}

