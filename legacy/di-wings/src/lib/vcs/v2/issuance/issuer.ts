import { EdDSACryptosuiteManager } from '../cryptosuites/eddsa';
import { type VerifiableCredential, type Credential } from '../models/credential';
import { type VerifiablePresentation, type Presentation } from '../models/presentation';
import { type Loader } from '../utils/document-loader';
import { DataIntegrityProofManager } from '../proofs/data-integrity';
import { validateCredential } from '../validation/credential';
import { validatePresentation } from '../validation/presentation';

export interface IssueOptions {
  proofPurpose: string;
  documentLoader: Loader;
  challenge?: string;
  domain?: string;
}

export class Issuer {
  private verificationMethod: any;

  constructor(verificationMethod: any) {
    this.verificationMethod = verificationMethod;
  }

  async issueCredential(credential: Credential, options: IssueOptions): Promise<VerifiableCredential> {
    if (!credential.issuer) {
      credential.issuer = this.verificationMethod.controller;
    }

    const proofOptions = {
      verificationMethod: this.verificationMethod.id,
      created: new Date().toISOString(),
      proofPurpose: options.proofPurpose,
      cryptosuite: 'eddsa-rdfc-2022',
      type: 'DataIntegrityProof' as const,
      privateKey: this.verificationMethod.secretKeyMultibase,
      documentLoader: options.documentLoader
    };
    const proof = await EdDSACryptosuiteManager.createProof(credential, proofOptions);
    const verifiableCredential: VerifiableCredential = {
      ...credential,
      proof: Array.isArray(proof) ? proof[0] : proof
    };
    validateCredential(verifiableCredential);

    return verifiableCredential;
  }

  async issuePresentation(presentation: Presentation, options: IssueOptions): Promise<VerifiablePresentation> {
    const proofOptions = {
      verificationMethod: this.verificationMethod.id,
      created: new Date().toISOString(),
      proofPurpose: options.proofPurpose,
      cryptosuite: 'eddsa-rdfc-2022',
      type: 'DataIntegrityProof' as const,
      privateKey: this.verificationMethod.secretKeyMultibase,
      documentLoader: options.documentLoader,
      challenge: options.challenge,
      domain: options.domain
    };
    const proof = await DataIntegrityProofManager.createProof(presentation, proofOptions);
    const verifiablePresentation: VerifiablePresentation = {
      ...presentation,
      proof: Array.isArray(proof) ? proof : [proof]
    };

    validatePresentation(verifiablePresentation);

    return verifiablePresentation;
  }
}
