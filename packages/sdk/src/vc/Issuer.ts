import { VerifiableCredential, VerifiablePresentation } from '../types';
import { multikey, MultikeyType } from '../crypto/Multikey';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';
import { DataIntegrityProofManager } from './proofs/data-integrity';

export interface IssueOptions {
  proofPurpose: 'assertionMethod' | 'authentication';
  documentLoader?: (iri: string) => Promise<{ document: unknown; documentUrl: string; contextUrl: string | null }>;
  challenge?: string;
  domain?: string;
}

// Default contexts for credentials issued without an explicit @context.
// The Originals context supplies an @vocab so issuer-specific terms are
// defined (and therefore signed) during safe-mode canonicalization.
const DEFAULT_CONTEXTS = [
  'https://www.w3.org/ns/credentials/v2',
  'https://originals.build/context'
];

const DATA_INTEGRITY_CONTEXT = 'https://w3id.org/security/data-integrity/v2';
// Contexts that already define the DataIntegrityProof terms used in proofs.
const SECURING_CONTEXTS = ['https://www.w3.org/ns/credentials/v2', DATA_INTEGRITY_CONTEXT];

/**
 * Ensure the document's @context defines the Data Integrity proof terms,
 * appending the data-integrity/v2 context when missing (mirrors the
 * behaviour of jsonld-signatures). Without it, safe-mode canonicalization
 * of the proof configuration fails for e.g. plain VCDM 1.1 credentials.
 */
function withSecuringContext(
  context: VerifiableCredential['@context'] | undefined
): VerifiableCredential['@context'] {
  if (context === undefined) return [...DEFAULT_CONTEXTS];
  const list = Array.isArray(context) ? context : [context];
  const hasSecuring = list.some((c) => typeof c === 'string' && SECURING_CONTEXTS.includes(c));
  return hasSecuring ? context : [...list, DATA_INTEGRITY_CONTEXT];
}

export type VerificationMethodLike = {
  id: string;
  controller: string;
  publicKeyMultibase: string;
  secretKeyMultibase?: string;
  type?: string;
};

export class Issuer {
  constructor(private didManager: DIDManager, private verificationMethod: VerificationMethodLike) {}

  private inferKeyType(publicKeyMultibase: string): MultikeyType {
    try {
      return multikey.decodePublicKey(publicKeyMultibase).type;
    } catch {
      return 'Ed25519';
    }
  }

  async issueCredential(
    unsigned: Omit<VerifiableCredential, '@context' | 'proof'> & { '@context'?: VerifiableCredential['@context'] },
    options: IssueOptions
  ): Promise<VerifiableCredential> {
    const documentLoader = options.documentLoader || createDocumentLoader(this.didManager);
    await documentLoader(this.verificationMethod.id);

    const issuerId = typeof unsigned.issuer === 'string' ? unsigned.issuer : (unsigned.issuer as { id?: string })?.id;
    // The credential's issuer must be the DID that controls the signing key.
    // Otherwise the issuer claim is decoupled from the key that signed it,
    // letting a holder of issuer A's key mint a credential claiming issuer B.
    // Fail closed: refuse to sign when the stated issuer doesn't own the key.
    const keyController = this.verificationMethod.controller || this.verificationMethod.id.split('#')[0];
    if (issuerId && issuerId !== keyController) {
      throw new Error(
        `Issuer DID (${issuerId}) does not match the verification method controller (${keyController})`
      );
    }
    const credential: VerifiableCredential = {
      ...unsigned,
      // Preserve the issuer-supplied @context so every stated term is part of
      // the signed dataset; only default when none was provided (issue #167).
      '@context': withSecuringContext(unsigned['@context']),
      issuer: issuerId || keyController
    } as VerifiableCredential;
    delete (credential as unknown as Record<string, unknown>).proof;

    if (!this.verificationMethod.secretKeyMultibase) {
      throw new Error('Missing secretKeyMultibase for issuance');
    }
    const keyType = this.inferKeyType(this.verificationMethod.publicKeyMultibase);
    if (keyType !== 'Ed25519') {
      throw new Error('Only Ed25519 supported for eddsa-rdfc-2022');
    }
    const proof = await DataIntegrityProofManager.createProof(credential, {
      verificationMethod: this.verificationMethod.id,
      proofPurpose: options.proofPurpose,
      cryptosuite: 'eddsa-rdfc-2022',
      type: 'DataIntegrityProof',
      privateKey: this.verificationMethod.secretKeyMultibase,
      documentLoader
    });
    return { ...credential, proof } as VerifiableCredential;
  }

  async issuePresentation(
    presentation: Omit<VerifiablePresentation, '@context' | 'proof'> & { '@context'?: VerifiablePresentation['@context'] },
    options: IssueOptions
  ): Promise<VerifiablePresentation> {
    const documentLoader = options.documentLoader || createDocumentLoader(this.didManager);
    await documentLoader(this.verificationMethod.id);

    if (!this.verificationMethod.secretKeyMultibase) {
      throw new Error('Missing secretKeyMultibase for issuance');
    }
    const keyType = this.inferKeyType(this.verificationMethod.publicKeyMultibase);
    if (keyType !== 'Ed25519') {
      throw new Error('Only Ed25519 supported for eddsa-rdfc-2022');
    }
    const presentationContext = withSecuringContext(presentation['@context']);
    const presentationWithContext = {
      ...presentation,
      '@context': presentationContext
    } as Record<string, unknown>;

    const proof = await DataIntegrityProofManager.createProof(
      presentationWithContext,
      {
        verificationMethod: this.verificationMethod.id,
        proofPurpose: options.proofPurpose,
        cryptosuite: 'eddsa-rdfc-2022',
        type: 'DataIntegrityProof',
        privateKey: this.verificationMethod.secretKeyMultibase,
        challenge: options.challenge,
        domain: options.domain,
        documentLoader
      }
    );
    return {
      ...presentation,
      '@context': presentationContext,
      proof
    } as VerifiablePresentation;
  }
}

