import jsonld from 'jsonld';
import { DIDDocument, VerifiableCredential } from '../types';

type DocumentLoader = (url: string) => Promise<{
  documentUrl: string;
  document: any;
  contextUrl: string | null;
}>;

// Import context documents from legacy/di-wings
import credentialsV2Context from '../../legacy/di-wings/src/lib/vcs/v2/contexts/credentials-v2.json';
import dataIntegrityV2Context from '../../legacy/di-wings/src/lib/vcs/v2/contexts/data-integrity-v2.json';
import didsContext from '../../legacy/di-wings/src/lib/vcs/v2/contexts/dids.json';
import ed255192020Context from '../../legacy/di-wings/src/lib/vcs/v2/contexts/ed255192020.json';
import ordinalsContext from '../../legacy/di-wings/src/lib/vcs/v2/contexts/ordinals-plus.json';
import originalsContext from '../../legacy/di-wings/src/lib/vcs/v2/contexts/originals.json';

// Full context documents for proper canonicalization
const PRELOADED_CONTEXTS: Record<string, any> = {
  // W3C Credentials v1 context (official)
  'https://www.w3.org/2018/credentials/v1': {
    "@context": {
      "@version": 1.1,
      "@protected": true,

      "id": "@id",
      "type": "@type",

      "VerifiableCredential": {
        "@id": "https://www.w3.org/2018/credentials#VerifiableCredential",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "id": "@id",
          "type": "@type",

          "cred": "https://www.w3.org/2018/credentials#",
          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",

          "credentialSchema": {
            "@id": "cred:credentialSchema",
            "@type": "@id",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "cred": "https://www.w3.org/2018/credentials#",

              "JsonSchemaValidator2018": "cred:JsonSchemaValidator2018"
            }
          },
          "credentialStatus": {"@id": "cred:credentialStatus", "@type": "@id"},
          "credentialSubject": {"@id": "cred:credentialSubject", "@type": "@id"},
          "evidence": {"@id": "cred:evidence", "@type": "@id"},
          "expirationDate": {"@id": "cred:expirationDate", "@type": "xsd:dateTime"},
          "holder": {"@id": "cred:holder", "@type": "@id"},
          "issued": {"@id": "cred:issued", "@type": "xsd:dateTime"},
          "issuer": {"@id": "cred:issuer", "@type": "@id"},
          "issuanceDate": {"@id": "cred:issuanceDate", "@type": "xsd:dateTime"},
          "proof": {"@id": "sec:proof", "@type": "@id", "@container": "@graph"},
          "refreshService": {
            "@id": "cred:refreshService",
            "@type": "@id",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "cred": "https://www.w3.org/2018/credentials#",

              "ManualRefreshService2018": "cred:ManualRefreshService2018"
            }
          },
          "termsOfUse": {"@id": "cred:termsOfUse", "@type": "@id"},
          "validFrom": {"@id": "cred:validFrom", "@type": "xsd:dateTime"},
          "validUntil": {"@id": "cred:validUntil", "@type": "xsd:dateTime"}
        }
      },

      "VerifiablePresentation": {
        "@id": "https://www.w3.org/2018/credentials#VerifiablePresentation",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "id": "@id",
          "type": "@type",

          "cred": "https://www.w3.org/2018/credentials#",
          "sec": "https://w3id.org/security#",

          "holder": {"@id": "cred:holder", "@type": "@id"},
          "proof": {"@id": "sec:proof", "@type": "@id", "@container": "@graph"},
          "verifiableCredential": {"@id": "cred:verifiableCredential", "@type": "@id", "@container": "@graph"}
        }
      },

      "EcdsaSecp256k1Signature2019": {
        "@id": "https://w3id.org/security#EcdsaSecp256k1Signature2019",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "id": "@id",
          "type": "@type",

          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",

          "challenge": "sec:challenge",
          "created": {"@id": "http://purl.org/dc/terms/created", "@type": "xsd:dateTime"},
          "domain": "sec:domain",
          "expires": {"@id": "sec:expiration", "@type": "xsd:dateTime"},
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "sec": "https://w3id.org/security#",

              "assertionMethod": {"@id": "sec:assertionMethod", "@type": "@id", "@container": "@set"},
              "authentication": {"@id": "sec:authenticationMethod", "@type": "@id", "@container": "@set"}
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {"@id": "sec:verificationMethod", "@type": "@id"}
        }
      },

      "EcdsaSecp256r1Signature2019": {
        "@id": "https://w3id.org/security#EcdsaSecp256r1Signature2019",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "id": "@id",
          "type": "@type",

          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",

          "challenge": "sec:challenge",
          "created": {"@id": "http://purl.org/dc/terms/created", "@type": "xsd:dateTime"},
          "domain": "sec:domain",
          "expires": {"@id": "sec:expiration", "@type": "xsd:dateTime"},
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "sec": "https://w3id.org/security#",

              "assertionMethod": {"@id": "sec:assertionMethod", "@type": "@id", "@container": "@set"},
              "authentication": {"@id": "sec:authenticationMethod", "@type": "@id", "@container": "@set"}
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {"@id": "sec:verificationMethod", "@type": "@id"}
        }
      },

      "Ed25519Signature2018": {
        "@id": "https://w3id.org/security#Ed25519Signature2018",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "id": "@id",
          "type": "@type",

          "sec": "https://w3id.org/security#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",

          "challenge": "sec:challenge",
          "created": {"@id": "http://purl.org/dc/terms/created", "@type": "xsd:dateTime"},
          "domain": "sec:domain",
          "expires": {"@id": "sec:expiration", "@type": "xsd:dateTime"},
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "sec": "https://w3id.org/security#",

              "assertionMethod": {"@id": "sec:assertionMethod", "@type": "@id", "@container": "@set"},
              "authentication": {"@id": "sec:authenticationMethod", "@type": "@id", "@container": "@set"}
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {"@id": "sec:verificationMethod", "@type": "@id"}
        }
      },

      "RsaSignature2018": {
        "@id": "https://w3id.org/security#RsaSignature2018",
        "@context": {
          "@version": 1.1,
          "@protected": true,

          "challenge": "sec:challenge",
          "created": {"@id": "http://purl.org/dc/terms/created", "@type": "xsd:dateTime"},
          "domain": "sec:domain",
          "expires": {"@id": "sec:expiration", "@type": "xsd:dateTime"},
          "jws": "sec:jws",
          "nonce": "sec:nonce",
          "proofPurpose": {
            "@id": "sec:proofPurpose",
            "@type": "@vocab",
            "@context": {
              "@version": 1.1,
              "@protected": true,

              "id": "@id",
              "type": "@type",

              "sec": "https://w3id.org/security#",

              "assertionMethod": {"@id": "sec:assertionMethod", "@type": "@id", "@container": "@set"},
              "authentication": {"@id": "sec:authenticationMethod", "@type": "@id", "@container": "@set"}
            }
          },
          "proofValue": "sec:proofValue",
          "verificationMethod": {"@id": "sec:verificationMethod", "@type": "@id"}
        }
      },

      "proof": {"@id": "https://w3id.org/security#proof", "@type": "@id", "@container": "@graph"}
    }
  },
  
  // Contexts from legacy/di-wings
  'https://www.w3.org/ns/credentials/v2': credentialsV2Context,
  'https://w3id.org/security/data-integrity/v2': dataIntegrityV2Context,
  'https://www.w3.org/ns/did/v1': didsContext,
  'https://w3id.org/security/suites/ed25519-2020/v1': ed255192020Context,
  'https://ordinals.plus/vocab/v1': ordinalsContext,
  'https://originals.build/context': originalsContext
};

const nodeDocumentLoader = jsonld.documentLoaders.node();

const defaultDocumentLoader: DocumentLoader = async (url: string) => {
  const preloaded = PRELOADED_CONTEXTS[url];
  if (preloaded) {
    return { documentUrl: url, document: preloaded, contextUrl: null };
  }
  return nodeDocumentLoader(url);
};

export function serializeDIDDocument(didDoc: DIDDocument): string {
  // Serialize to JSON-LD with proper context
  return JSON.stringify(didDoc, null, 2);
}

export function deserializeDIDDocument(data: string): DIDDocument {
  // Parse from JSON-LD
  try {
    const parsed = JSON.parse(data);
    return parsed as DIDDocument;
  } catch (error) {
    throw new Error('Invalid DID Document JSON');
  }
}

export function serializeCredential(vc: VerifiableCredential): string {
  // Serialize VC to JSON-LD
  return JSON.stringify(vc, null, 2);
}

export function deserializeCredential(data: string): VerifiableCredential {
  // Parse VC from JSON-LD
  try {
    const parsed = JSON.parse(data);
    return parsed as VerifiableCredential;
  } catch (error) {
    throw new Error('Invalid Verifiable Credential JSON');
  }
}

export async function canonicalizeDocument(
  doc: any,
  options: { documentLoader?: DocumentLoader } = {}
): Promise<string> {
  try {
    return await jsonld.canonize(doc, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader: options.documentLoader ?? defaultDocumentLoader,
      useNative: false,
      rdfDirection: 'i18n-datatype',
      safe: false  // Disable safe mode to allow custom contexts
    } as any);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    throw new Error(`Failed to canonicalize document: ${message}`);
  }
}


