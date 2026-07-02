import type { DIDDocument } from '../types/did.js';

export interface BtcoInscriptionData {
  inscriptionId: string;
  content: string;
  metadata: Record<string, unknown> | null;
  contentUrl?: string;
  contentType?: string;
  isValidDid?: boolean;
  didDocument?: DIDDocument | null;
  deactivated?: boolean;
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
}

export class BtcoDidResolver {
  private readonly options: BtcoDidResolutionOptions;

  constructor(options: BtcoDidResolutionOptions = {}) {
    this.options = options;
  }

  private parseBtcoDid(did: string): { satNumber: string; path?: string; network: string } | null {
    const regex = /^did:btco(?::(reg|sig|test))?:([0-9]+)(?:\/(.+))?$/;
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
      case 'test':
      case 'testnet':
        return 'did:btco:test';
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

        // The DID document MUST come from the on-chain inscription CONTENT,
        // never from the off-chain ord metadata endpoint. The metadata is
        // surfaced for diagnostics only — trusting it would let an attacker who
        // controls/spoofs the metadata API inject forged verification methods
        // and forge signatures on this did:btco identity.
        const documentFromContent = this.parseDidDocumentFromContent(inscriptionData.content);

        // A content blob "is a DID" if it either matches the human-readable
        // pattern or parses to a DID document carrying the expected id.
        inscriptionData.isValidDid =
          didPattern.test(inscriptionData.content) ||
          (documentFromContent !== null && documentFromContent.id === expectedDid);

        if (inscriptionData.content.includes('🔥')) {
          // Deactivation marker: the DID is tombstoned. Do not attempt to derive
          // a document; just record the deactivation.
          inscriptionData.didDocument = null;
          inscriptionData.deactivated = true;
          if (!inscriptionData.error) {
            inscriptionData.error = 'DID has been deactivated';
          }
        } else if (inscriptionData.isValidDid) {
          if (
            documentFromContent &&
            this.isValidDidDocument(documentFromContent) &&
            documentFromContent.id === expectedDid
          ) {
            inscriptionData.didDocument = documentFromContent;
          } else {
            inscriptionData.error = 'Invalid DID document structure or mismatched ID';
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        inscriptionData.error = `Failed to process inscription: ${message}`;
      }

      inscriptionDataList.push(inscriptionData);
    }

    // Walk backwards from the newest inscription: the most recent
    // lifecycle-relevant inscription (a tombstone or a valid DID document)
    // decides the outcome. A tombstone MUST NOT fall through to an older
    // document — that would resurrect a deactivated DID.
    let latestValidDidDocument: DIDDocument | null = null;
    let latestInscriptionId: string | undefined;
    let deactivated = false;
    for (let i = inscriptionDataList.length - 1; i >= 0; i--) {
      const data = inscriptionDataList[i];
      if (data.deactivated) {
        deactivated = true;
        latestInscriptionId = data.inscriptionId;
        break;
      }
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
        totalInscriptions: inscriptionDataList.length,
        ...(deactivated ? { message: 'DID has been deactivated' } : {})
      },
      didDocumentMetadata: {
        inscriptionId: latestInscriptionId,
        network,
        ...(deactivated ? { deactivated: true } : {})
      }
    };
  }

  /**
   * Parses the DID document out of the raw on-chain inscription content.
   *
   * The content is the authoritative artifact for a did:btco. It may be either
   * the bare DID-document JSON, or that JSON preceded by a human-readable
   * `BTCO DID: <did>` marker line. This strips any leading non-JSON marker text
   * and parses the JSON object portion. Returns `null` if no valid JSON object
   * can be recovered. The caller is responsible for structural / id validation.
   */
  private parseDidDocumentFromContent(content: string): DIDDocument | null {
    if (typeof content !== 'string') return null;
    // Strip an optional leading `BTCO DID: ` marker.
    let text = content.replace(/^\s*BTCO DID:\s*/i, '');
    // Locate the JSON object portion (the document may be preceded by a plain
    // `did:btco:...` marker line before the JSON body).
    const start = text.indexOf('{');
    if (start === -1) return null;
    text = text.slice(start);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as DIDDocument;
    } catch {
      return null;
    }
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

  private createErrorResult(error: string, message: string): BtcoDidResolutionResult {
    return {
      didDocument: null,
      resolutionMetadata: { error, message },
      didDocumentMetadata: {}
    };
  }
}

