import { 
  VerifiableCredential, 
  VerifiablePresentation, 
  CredentialSubject, 
  OriginalsConfig,
  Proof 
} from '../types';
import { canonicalizeDocument } from '../utils/serialization';
import { encodeBase64UrlMultibase, decodeBase64UrlMultibase } from '../utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from '../crypto/Signer';

export class CredentialManager {
  constructor(private config: OriginalsConfig) {}

  async createResourceCredential(
    type: 'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated',
    subject: CredentialSubject,
    issuer: string
  ): Promise<VerifiableCredential> {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', type],
      issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: subject
    };
  }

  async signCredential(
    credential: VerifiableCredential,
    privateKeyMultibase: string,
    verificationMethod: string
  ): Promise<VerifiableCredential> {
    // Sign credential as JSON-LD with proof
    const proofBase: Proof = {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: ''
    };
    const proofValue = await this.generateProofValue(credential, privateKeyMultibase, proofBase);
    const proof: Proof = { ...proofBase, proofValue };

    return {
      ...credential,
      proof
    };
  }

  async verifyCredential(credential: VerifiableCredential): Promise<boolean> {
    // Verify JSON-LD credential signature and integrity
    const proof = credential.proof as Proof | undefined;
    if (!proof) {
      return false;
    }

    const { proofValue, verificationMethod } = proof;
    if (!proofValue || !verificationMethod) return false;

    const signature = this.decodeMultibase(proofValue);
    if (!signature) return false;

    // di-wings style: hash(hash(c14n(proofSansProofValue)) + hash(c14n(credentialSansProof)))
    const proofSansValue = { ...proof } as any;
    delete proofSansValue.proofValue;
    const c14nProof = canonicalizeDocument(proofSansValue);
    const c14nCred = canonicalizeDocument({ ...credential, proof: undefined } as any);
    const hProof = Buffer.from(sha256(Buffer.from(c14nProof)));
    const hCred = Buffer.from(sha256(Buffer.from(c14nCred)));
    const digest = Buffer.concat([hProof, hCred]);
    const signer = this.getSigner();
    try {
      return await signer.verify(Buffer.from(digest), Buffer.from(signature), verificationMethod);
    } catch {
      return false;
    }
  }

  async createPresentation(
    credentials: VerifiableCredential[],
    holder: string
  ): Promise<VerifiablePresentation> {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      holder,
      verifiableCredential: credentials
    } as any;
  }

  private async generateProofValue(
    credential: VerifiableCredential, 
    privateKeyMultibase: string,
    proofBase: Proof
  ): Promise<string> {
    // Construct canonical digest including provided proof sans proofValue
    const proofSansValue = { ...proofBase } as any;
    delete proofSansValue.proofValue;
    const c14nProof = canonicalizeDocument(proofSansValue);
    const c14nCred = canonicalizeDocument({ ...credential, proof: undefined } as any);
    const hProof = Buffer.from(sha256(Buffer.from(c14nProof)));
    const hCred = Buffer.from(sha256(Buffer.from(c14nCred)));
    const digest = Buffer.concat([hProof, hCred]);
    const signer = this.getSigner();
    const sig = await signer.sign(Buffer.from(digest), privateKeyMultibase);
    return encodeBase64UrlMultibase(sig);
  }

  private getSigner(): Signer {
    switch (this.config.defaultKeyType) {
      case 'ES256K':
        return new ES256KSigner();
      case 'Ed25519':
        return new Ed25519Signer();
      case 'ES256':
        return new ES256Signer();
      default:
        return new ES256KSigner();
    }
  }

  private decodeMultibase(s: string): Uint8Array | null {
    try {
      return decodeBase64UrlMultibase(s);
    } catch {
      return null;
    }
  }
}


