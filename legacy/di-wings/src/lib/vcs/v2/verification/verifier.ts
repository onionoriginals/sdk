import type { VerifiableCredential } from '../models/credential';
import type { VerifiablePresentation } from '../models/presentation';
import { DataIntegrityProofManager } from '../proofs/data-integrity';
import { VerificationError } from '../errors';
import { createDocumentLoader } from '../utils/document-loader';
import { validateCredential } from '../validation/credential';
import { validateVerifiablePresentation } from '../validation/presentation';
import type { VerificationResult } from '../../../crypto';

export class Verifier {
  static async verifyCredential(verifiableCredential: VerifiableCredential, options: { documentLoader?: (url: string) => Promise<any> } = {}): Promise<VerificationResult> {
    try {
      // Validate the verifiable credential before verification
      validateCredential(verifiableCredential);
      if (!verifiableCredential.proof) {
        throw new Error('Credential has no proof');
      }

      const documentLoader = options.documentLoader || createDocumentLoader();
      const result = await DataIntegrityProofManager.verifyProof(verifiableCredential, verifiableCredential.proof, { documentLoader });
      return {
        verified: result.verified,
        errors: result.errors
      };
    } catch (error) {
      return {
        verified: false,
        errors: [error instanceof Error ? error.message : 'Unknown error in verifyCredential']
      };
    }
  }

  static async verifyPresentation(presentation: VerifiablePresentation, options: { documentLoader?: (url: string) => Promise<any> } = {}): Promise<VerificationResult> {
    try {
      // Validate the verifiable presentation before verification
      validateVerifiablePresentation(presentation);

      if (!presentation.proof) {
        throw new VerificationError('Presentation has no proof');
      }

      const documentLoader = options.documentLoader || createDocumentLoader();
      const presentationResult = await DataIntegrityProofManager.verifyProof(
        presentation, 
        presentation.proof, 
        { documentLoader }
      );

      if (!presentationResult.verified) {
        return presentationResult;
      }

      const credentialResults: VerificationResult[] = [];
      if (presentation.verifiableCredential) {
        for (const credential of presentation.verifiableCredential) {
          const credResult = await this.verifyCredential(credential as VerifiableCredential, { documentLoader });
          credentialResults.push(credResult);
          if (!credResult.verified) {
            return {
              verified: false,
              errors: ['One or more credentials failed verification']
            };
          }
        }
      }

      return {
        verified: true,
        errors: []
      };
    } catch (error) {
      return {
        verified: false,
        errors: [error instanceof Error ? error.message : 'Unknown error in verifyPresentation']
      };
    }
  }
}
