import { IssuanceService as IssuanceServiceV1 } from './v1/issue';
import { VerificationService as VerificationServiceV1 } from './v1/verify';
import { PresentationService as PresentationServiceV1 } from './v1/present';
import { Issuer as IssuerV2 } from './v2/issuance/issuer';
import { Verifier as VerifierV2 } from './v2/verification/verifier';
import { createDocumentLoader } from './v2/utils/document-loader';
import { Multikey } from '../crypto/keypairs/Multikey';
import { Ed25519Signature2018LinkedDataProof, Ed25519VerificationKey2020, type VerificationResult } from '../crypto';
import { VerificationError } from './v2/errors';
import { PresentationService } from './v1';

// Export versioned implementations directly for users who need specific versions
export const v1 = {
  IssuanceService: IssuanceServiceV1,
  VerificationService: VerificationServiceV1,
  PresentationService: PresentationServiceV1,
};

export const v2 = {
  Issuer: IssuerV2,
  Verifier: VerifierV2,
};

// Main classes that handle both versions
export class Issuer {
  static async issue(credential: any, options: any): Promise<any> {
    if (credential['@context'][0] === 'https://www.w3.org/ns/credentials/v2') {
      const issuer = new IssuerV2(options.verificationMethod);
      
      // If credential already has proofs, ensure it's an array
      if (credential.proof) {
        credential.proof = Array.isArray(credential.proof) ? credential.proof : [credential.proof];
      }
      
      const issued = await issuer.issueCredential(credential, {
        proofPurpose: options.proofPurpose || 'assertionMethod',
        documentLoader: options.documentLoader || createDocumentLoader()
      });
      
      // Ensure the final proof is an array
      if (!Array.isArray(issued.proof)) {
        issued.proof = [issued.proof];
      }
      return issued;
    } else {
      const key = Multikey.fromMultibase(options.verificationMethod);
      return IssuanceServiceV1.issueCredential(credential, {
        ...options,
        suite: key,
        type: 'vc-ld',
        documentLoader: options.documentLoader || createDocumentLoader()
      });
    }
  }

  static async present(presentation: any, options: any): Promise<any> {
    if (presentation['@context'][0] === 'https://www.w3.org/ns/credentials/v2') {
      const issuer = new IssuerV2(options.verificationMethod);
      
      // Handle existing proofs in the presentation
      if (presentation.proof) {
        presentation.proof = Array.isArray(presentation.proof) ? presentation.proof : [presentation.proof];
      }
      
      const issued = await issuer.issuePresentation(presentation, {
        proofPurpose: options.proofPurpose || 'assertionMethod',
        documentLoader: options.documentLoader || createDocumentLoader()
      });
      
      // Ensure the final proof is an array
      if (!Array.isArray(issued.proof)) {
        issued.proof = [issued.proof];
      }
      return issued;
    } else {
      const key = Multikey.fromMultibase(options.verificationMethod);
      return PresentationServiceV1.provePresentation(presentation, {
        ...options,
        suite: key,
        type: 'vc-ld',
        documentLoader: options.documentLoader || createDocumentLoader()
      });
    }
  }
}

export class Verifier {
  async verifyCredential(verifiableCredential: any, options: any = {}): Promise<any> {
    if (verifiableCredential['@context'][0] === 'https://www.w3.org/ns/credentials/v2') {
      return VerifierV2.verifyCredential(verifiableCredential, { ...options, documentLoader: options.documentLoader || createDocumentLoader() });
    } else {
      return await VerificationServiceV1.verifyCredential(verifiableCredential, options.suite, options.documentLoader || createDocumentLoader());
    }
  }

  async verifyPresentation(verifiablePresentation: any, options: any = {}): Promise<VerificationResult> {
    if (verifiablePresentation['@context'][0] === 'https://www.w3.org/ns/credentials/v2') {
      return await VerifierV2.verifyPresentation(verifiablePresentation, { ...options, documentLoader: options.documentLoader || createDocumentLoader() });
    } else if (verifiablePresentation['@context'][0] === 'https://www.w3.org/ns/credentials/v1') {
      return VerificationServiceV1.verifyPresentation(verifiablePresentation, options.suite, options.documentLoader || createDocumentLoader());
    } else {
      throw new VerificationError(`Unsupported first context: ${verifiablePresentation['@context'][0]}`);
    }
  }
}

// Default exports point to the latest version-aware implementations
export default {
  Issuer,
  Verifier,
};

// Type exports for better TypeScript support
export type { VerificationResult };

export { createDocumentLoader };



