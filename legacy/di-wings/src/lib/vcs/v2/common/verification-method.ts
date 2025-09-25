import { multibase, MULTICODEC_BLS12381_G2_PUB_HEADER, multikey } from "../../../crypto/utils/encoding";
import { ProblemDetailsError } from "../errors";
import type { DocumentLoader } from "../utils/document-loader";

export class VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: object;

  constructor(data: Partial<VerificationMethod>) {
    this.id = data.id!;
    this.type = data.type!;
    this.controller = data.controller!;
    this.publicKeyMultibase = data.publicKeyMultibase;
    this.publicKeyJwk = data.publicKeyJwk;
  }

  toJSON?(): object {
    return {
      id: this.id,
      type: this.type,
      controller: this.controller,
      ...(this.publicKeyMultibase && { publicKeyMultibase: this.publicKeyMultibase }),
      ...(this.publicKeyJwk && { publicKeyJwk: this.publicKeyJwk }),
    };
  }
}

/**
   * Helper method to retrieve public key bytes from a verification method
   * 
   * @param verificationMethod - The verification method ID
   * @param documentLoader - Optional document loader for resolving the verification method
   * @returns Promise<Uint8Array> The public key bytes
   * @throws Error if verification method cannot be resolved or is invalid
   */
export const getPublicKeyFromVerificationMethod = async (
  verificationMethod: string,
  documentLoader?: (iri: string) => Promise<{ document: any; documentUrl: string; contextUrl: string | null }>
): Promise<Uint8Array> => {
  try {
    if (!documentLoader) {
      throw new Error('Document loader is required to resolve verification method');
    }

    const result = await documentLoader(verificationMethod);
    if (!result || !result.document || !result.document.publicKeyMultibase) {
      throw new Error('Invalid verification method document');
    }
    return multikey.decode(MULTICODEC_BLS12381_G2_PUB_HEADER, result.document.publicKeyMultibase);
  } catch (err: any) {
    throw new ProblemDetailsError(
      'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
      'Failed to resolve verification method',
      err.message,
      -16
    );
  }
}