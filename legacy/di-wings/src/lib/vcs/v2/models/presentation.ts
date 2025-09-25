import { type Credential, type VerifiableCredential } from './credential';
import { type ProofType } from '../proofs/data-integrity';

export interface Presentation {
  '@context': string[];
  id?: string;
  type: string[];
  verifiableCredential: VerifiableCredential[];
  holder?: string;
}

export interface VerifiablePresentation extends Presentation {
  proof: ProofType[] | ProofType;
}
