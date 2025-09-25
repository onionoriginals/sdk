import type { DataIntegrityProof } from '../proofs/data-integrity';
import { ProofError } from '../errors';
import { multibase, MULTICODEC_ED25519_PUB_HEADER, MULTICODEC_ED25519_PRIV_HEADER, multikey } from '../../../crypto/utils/encoding';
import * as ed25519 from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { canonize, canonizeProof } from '../../../crypto/utils/vcs';
import type { DocumentLoader } from '../../../common/interfaces';
import type { VerificationResult } from '../../../crypto';

export interface VerifyProofOptions {
  documentLoader: DocumentLoader;
  challenge?: string;
  domain?: string;
  preserveProof?: boolean;
}

export class EdDSACryptosuiteManager {
  public static name = 'eddsa-rdfc-2022';

  static async createProof(document: any, options: any): Promise<DataIntegrityProof> {
    try {
      const proofConfig = await this.createProofConfiguration(options);
      const transformedData = await this.transform(document, options);
      const hashData = await this.hash(transformedData, proofConfig, options);
      let privateKey: Uint8Array;
      if (typeof options.privateKey === 'string') {
        privateKey = multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, options.privateKey);
      } else if (options.privateKey instanceof Uint8Array) {
        privateKey = options.privateKey;
      } else {
        throw new Error('Invalid private key format');
      }
      const proofValue = await this.sign({ data: hashData, privateKey });
      delete proofConfig['@context'];
      const proof = {
        ...proofConfig,
        proofValue: multibase.encode(proofValue, "base58btc")
      };
      return proof;
    } catch (error: any) {
      throw new ProofError(`Failed to create proof: ${error.message}`);
    }
  }

  static async verifyProof(
    document: any,
    proof: DataIntegrityProof,
    options: VerifyProofOptions
  ): Promise<VerificationResult> {
    try {
      const { preserveProof, ...restOptions } = options;
      
      // Create a copy of the document if we're not preserving the proof
      const documentToVerify = preserveProof ? document : { ...document };
      if (!preserveProof) {
        delete documentToVerify.proof;
      }

      const transformedData = await this.transform(documentToVerify, restOptions);
      const hashData = await this.hash(transformedData, {'@context': document['@context'], ...proof}, restOptions);
      const publicKey = await this.getPublicKey(proof.verificationMethod, restOptions.documentLoader);
      const signature = multibase.decode(proof.proofValue);
      
      // Add validation for signature length
      if ((publicKey.length === 32 && signature.length !== 64) ||
          (publicKey.length === 57 && signature.length !== 114)) {
        throw new Error('Invalid signature length for the given public key size');
      }
      const verified = await this.verify({
        data: hashData,
        signature,
        publicKey
      }); 

      if (!verified) {
        return { verified: false, errors: ['Proof verification failed'] };
      }

      return { verified: true };
    } catch (error) {
      return { 
        verified: false, 
        errors: [error instanceof Error ? error.message : 'Unknown error during verification' ]
      };
    }
  }

  private static async createProofConfiguration(options: any): Promise<any> {
    // Implement as per section 3.2.5 or 3.3.5 of the spec
    // This is a simplified version
    return {
      '@context': 'https://w3id.org/security/data-integrity/v2',
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: new Date().toISOString(),
      verificationMethod: options.verificationMethod,
      proofPurpose: options.proofPurpose || 'assertionMethod',
      ...(options.challenge && { challenge: options.challenge }),
      ...(options.domain && { domain: options.domain })
    };
  }

  private static async transform(document: any, options: any): Promise<string> {
    // Implement as per section 3.2.3 or 3.3.3 of the spec
    return await canonize(document, { documentLoader: options.documentLoader });
  }

  private static async hash(transformedData: string, proofConfig: any, options: any): Promise<Uint8Array> {
    // Implement as per section 3.2.4 or 3.3.4 of the spec
    const canonicalProofConfig = await canonizeProof(proofConfig, options);
    const proofConfigHash = sha256(canonicalProofConfig);
    const documentHash = sha256(transformedData);
    return new Uint8Array([...proofConfigHash, ...documentHash]);
  }

  static async sign({ data, privateKey }: { data: Uint8Array; privateKey: Uint8Array }): Promise<Uint8Array> {
    try {
      // Ensure the private key is in the correct format (32 bytes)
      if (privateKey.length !== 32) {
        if (privateKey.length === 64) {
          privateKey = privateKey.slice(32);
        } else {
          throw new Error('Invalid private key length');
        }
      }

      // Sign the data using Ed25519
      const signature = await ed25519.signAsync(Buffer.from(data).toString('hex'), Buffer.from(privateKey).toString('hex'));
      return signature;
    } catch (error: any) {
      throw new ProofError(`Signing failed: ${error.message}`);
    }
  }

  static async verify({ data, signature, publicKey }: { data: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }): Promise<boolean> {
    try {
      return await ed25519.verifyAsync(Buffer.from(signature).toString('hex'), Buffer.from(data).toString('hex'), Buffer.from(publicKey).toString('hex'));
    } catch (error: any) {
      throw new ProofError(`Verification failed: ${error.message}`);
    }
  }

  private static async getPublicKey(verificationMethod: string, documentLoader: DocumentLoader): Promise<Uint8Array> {
    const document = await documentLoader(verificationMethod);
    if (!document.document.publicKeyMultibase) {
      throw new ProofError('Public key not found in verification method');
    }
    return multikey.decode(MULTICODEC_ED25519_PUB_HEADER, document.document.publicKeyMultibase);
  }
}
