import { VerifiableCredential, VerifiablePresentation, Proof } from '../types';
import { multikey, MultikeyType } from '../crypto/Multikey';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';
import { DataIntegrityProofManager } from './proofs/data-integrity';

export interface IssueOptions {
  proofPurpose: 'assertionMethod' | 'authentication';
  documentLoader?: (iri: string) => Promise<{ document: any; documentUrl: string; contextUrl: string | null }>;
  challenge?: string;
  domain?: string;
}

export type VerificationMethodLike = {
  id: string;
  controller: string;
  publicKeyMultibase: string;
  secretKeyMultibase?: string;
  type?: 'Multikey' | string;
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
    unsigned: Omit<VerifiableCredential, '@context' | 'proof'>,
    options: IssueOptions
  ): Promise<VerifiableCredential> {
    const documentLoader = options.documentLoader || createDocumentLoader(this.didManager);
    await documentLoader(this.verificationMethod.id);

    const issuerId = typeof unsigned.issuer === 'string' ? unsigned.issuer : (unsigned.issuer as any)?.id;
    const credential: VerifiableCredential = {
      ...unsigned,
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      issuer: issuerId || this.verificationMethod.controller,
      proof: undefined
    } as any;

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
    return { ...credential, proof } as any;
  }

  async issuePresentation(
    presentation: Omit<VerifiablePresentation, '@context' | 'proof'>,
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
    const proof = await DataIntegrityProofManager.createProof(
      { ...(presentation as any), '@context': ['https://www.w3.org/ns/credentials/v2'] },
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
      ...(presentation as any),
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      proof
    } as VerifiablePresentation;
  }
}

