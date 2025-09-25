import { type DataIntegrityProof, type ProofType } from '../proofs/data-integrity';

export interface Credential {
  '@context': ["https://www.w3.org/ns/credentials/v2", ...(string | object)[]];
  id?: string;
  type: string[];
  issuer: string | { 
    id: string; 
    name?: string | object; 
    description?: string | object 
  };
  validFrom?: string;
  validUntil?: string;
  credentialSubject: Record<string, any>;
  credentialStatus?: {
    id: string;
    type: string;
  };
  name?: string | object;
  description?: string | object;
  credentialSchema?: {
    id: string;
    type: string;
  };
  termsOfUse?: Array<{ type: string }>;
  evidence?: Array<{ id?: string; type: string[] }>;
  refreshService?: {
    id: string;
    type: string;
  };
  relatedResource?: Array<{
    id: string;
    digestSRI?: string;
    digestMultibase?: string;
  }>;
}

export interface VerifiableCredential extends Credential {
  proof: DataIntegrityProof[] | DataIntegrityProof;
}
