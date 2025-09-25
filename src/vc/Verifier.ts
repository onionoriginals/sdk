import { VerifiableCredential, VerifiablePresentation } from '../types';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';

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
      return { verified: true, errors: [] };
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
      return { verified: true, errors: [] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown error in verifyPresentation'] };
    }
  }
}

