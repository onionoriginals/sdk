import type { DataIntegrityProof } from './proofs/data-integrity';

export interface VerifiableCredential {
  "@context": (string | Record<string, string>)[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: Record<string, any>;
  proof?: DataIntegrityProof;
} 