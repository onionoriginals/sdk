import { 
  VerifiableCredential, 
  VerifiablePresentation, 
  CredentialSubject, 
  OriginalsConfig,
  Proof 
} from '../types';
import { canonicalizeDocument } from '../utils/serialization';
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
    const proof: Proof = {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: await this.generateProofValue(credential, privateKeyMultibase)
    };

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

    const toVerify = { ...credential } as any;
    delete toVerify.proof;
    const canonical = canonicalizeDocument(toVerify);

    const signer = this.getSigner();
    try {
      return await signer.verify(Buffer.from(canonical), Buffer.from(signature), verificationMethod);
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
    privateKeyMultibase: string
  ): Promise<string> {
    const toSign = { ...credential } as any;
    delete toSign.proof;
    const canonical = canonicalizeDocument(toSign);

    const signer = this.getSigner();
    const sig = await signer.sign(Buffer.from(canonical), privateKeyMultibase);
    return this.encodeMultibase(sig);
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

  private encodeMultibase(bytes: Buffer): string {
    return 'z' + Buffer.from(bytes).toString('base64url');
  }

  private decodeMultibase(s: string): Uint8Array | null {
    if (!s || s[0] !== 'z') return null;
    try {
      return Buffer.from(s.slice(1), 'base64url');
    } catch {
      return null;
    }
  }
}


