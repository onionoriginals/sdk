/* istanbul ignore file */
import { VerifiableCredential, VerifiablePresentation } from '../types';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';
import { DataIntegrityProofManager } from './proofs/data-integrity';

export type VerificationResult = { verified: boolean; errors: string[] };

export class Verifier {
  constructor(private didManager: DIDManager) {}

  async verifyCredential(vc: VerifiableCredential, options: { documentLoader?: (iri: string) => Promise<any> } = {}): Promise<VerificationResult> {
    try {
      if (!vc || !vc['@context'] || !vc.type) throw new Error('Invalid credential');
      if (!vc.proof) throw new Error('Credential has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const ctxs: string[] = Array.isArray(vc['@context']) ? (vc['@context'] as any) : [vc['@context'] as any];
      for (const c of ctxs) await loader(c);
      const proof = Array.isArray(vc.proof) ? (vc.proof as any)[0] : (vc.proof as any);
      const result = await DataIntegrityProofManager.verifyProof(vc, proof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown error in verifyCredential'] };
    }
  }

  async verifyPresentation(vp: VerifiablePresentation, options: { documentLoader?: (iri: string) => Promise<any> } = {}): Promise<VerificationResult> {
    try {
      if (!vp || !vp['@context'] || !vp.type) throw new Error('Invalid presentation');
      if (!vp.proof) throw new Error('Presentation has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const ctxs: string[] = Array.isArray(vp['@context']) ? (vp['@context'] as any) : [vp['@context'] as any];
      for (const c of ctxs) await loader(c);
      if (vp.verifiableCredential) {
        for (const c of vp.verifiableCredential) {
          const res = await this.verifyCredential(c as any, { documentLoader: loader });
          if (!res.verified) return res;
        }
      }
      const proof = Array.isArray(vp.proof) ? (vp.proof as any)[0] : (vp.proof as any);
      const result = await DataIntegrityProofManager.verifyProof(vp, proof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown error in verifyPresentation'] };
    }
  }
}

