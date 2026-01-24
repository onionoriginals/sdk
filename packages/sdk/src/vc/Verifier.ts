import { VerifiableCredential, VerifiablePresentation } from '../types';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';
import { DataIntegrityProofManager } from './proofs/data-integrity';
import type { DataIntegrityProof } from './cryptosuites/eddsa';

export type VerificationResult = { verified: boolean; errors: string[] };

export class Verifier {
  constructor(private didManager: DIDManager) {}

  async verifyCredential(vc: VerifiableCredential, options: { documentLoader?: (iri: string) => Promise<unknown> } = {}): Promise<VerificationResult> {
    try {
      if (!vc || !vc['@context'] || !vc.type) throw new Error('Invalid credential');
      if (!vc.proof) throw new Error('Credential has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const vcContext = vc['@context'];
      const ctxs: string[] = Array.isArray(vcContext) ? vcContext.filter((c): c is string => typeof c === 'string') : [String(vcContext)];
      for (const c of ctxs) await loader(c);
      const proofValue = vc.proof;
      const proof = Array.isArray(proofValue) ? proofValue[0] : proofValue;
      const result = await DataIntegrityProofManager.verifyProof(vc, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [error?.message ?? 'Unknown error in verifyCredential'] };
    }
  }

  async verifyPresentation(vp: VerifiablePresentation, options: { documentLoader?: (iri: string) => Promise<unknown> } = {}): Promise<VerificationResult> {
    try {
      if (!vp || !vp['@context'] || !vp.type) throw new Error('Invalid presentation');
      if (!vp.proof) throw new Error('Presentation has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const vpContext = vp['@context'];
      const ctxs: string[] = Array.isArray(vpContext) ? vpContext.filter((c): c is string => typeof c === 'string') : [String(vpContext)];
      for (const c of ctxs) await loader(c);
      if (vp.verifiableCredential) {
        for (const c of vp.verifiableCredential) {
          const res = await this.verifyCredential(c, { documentLoader: loader });
          if (!res.verified) return res;
        }
      }
      const proofValue = vp.proof;
      const proof = Array.isArray(proofValue) ? proofValue[0] : proofValue;
      const result = await DataIntegrityProofManager.verifyProof(vp, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [error?.message ?? 'Unknown error in verifyPresentation'] };
    }
  }
}

