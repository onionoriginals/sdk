import { DIDResolver } from '../identifiers/did-resolver';
import { ProofError } from '../errors';

import credentials from '../contexts/credentials.json';
import credentials2 from '../contexts/credentials-v2.json';
import credentials2Examples from '../contexts/credentials-v2-examples.json';
import dids from '../contexts/dids.json';
import ed255192020 from '../contexts/ed255192020.json';
import dataIntegrity2 from '../contexts/data-integrity-v2.json';
import ordinalsPlus from '../contexts/ordinals-plus.json';
import originals from '../contexts/originals.json';

export type Loader = (iri: string) => Promise<{ document: any; documentUrl: string; contextUrl: string | null }>;

const documents: Record<string, any> = {
  'https://www.w3.org/2018/credentials/v1': credentials,
  'https://www.w3.org/ns/credentials/v2': credentials2,
  'https://www.w3.org/ns/credentials/examples/v2': credentials2Examples,
  'https://www.w3.org/ns/did/v1': dids,
  'https://w3id.org/security/suites/ed25519-2020/v1': ed255192020,
  'https://w3id.org/security/data-integrity/v2': dataIntegrity2,
  'https://ordinals.plus/vocab/v1': ordinalsPlus,
  'https://originals.build/context': originals
};

export class DocumentLoader {
  private didResolver: DIDResolver;

  constructor() {
    this.didResolver = new DIDResolver();
  }

  async load(iri: string): Promise<{ document: any; documentUrl: string; contextUrl: string | null }> {
    try {
      if (iri.startsWith('did:')) {
        return this.resolveDID(iri);
      }

      if (documents[iri]) {
        return {
          document: documents[iri],
          documentUrl: iri,
          contextUrl: null
        };
      }

      throw new Error(`Document not found: ${iri}`);

    } catch (error: any) {
      throw new ProofError(`Failed to load document: ${error.message}`);
    }
  }

  private async resolveDID(did: string): Promise<{ document: any; documentUrl: string; contextUrl: string | null }> {
    const document = await this.didResolver.resolve(did);

    if (did.includes('#') && document.verificationMethod) {
      const verificationMethod = document.verificationMethod.find((vm: any) => vm.id === did);
      if (verificationMethod) {
        return {
          document: {
            '@context': document['@context'],
            ...verificationMethod
          },
          documentUrl: did,
          contextUrl: null
        };
      }
    }

    return {
      document,
      documentUrl: did,
      contextUrl: null
    };
  }
}

export const createDocumentLoader = (): (iri: string) => Promise<{ document: any; documentUrl: string; contextUrl: string | null }> => {
  return (iri: string) => new DocumentLoader().load(iri);
};
