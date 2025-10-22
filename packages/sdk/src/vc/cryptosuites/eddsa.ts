import { base58 } from '@scure/base';
import * as ed25519 from '@noble/ed25519';
import { canonize, canonizeProof } from '../utils/jsonld';
import { multikey } from '../../crypto/Multikey';
import { sha256Bytes } from '../../utils/hash';

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: string;
  created?: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  id?: string;
  previousProof?: string | string[];
}

export interface VerificationResult {
  verified: boolean;
  errors?: string[];
}

export class EdDSACryptosuiteManager {

  static async createProof(document: any, options: any): Promise<DataIntegrityProof> {
    const proofConfig = await this.createProofConfiguration(options);
    const transformedData = await this.transform(document, options);
    const hashData = await this.hash(transformedData, proofConfig, options);
    let privateKey: Uint8Array;
    if (typeof options.privateKey === 'string') {
      const dec = multikey.decodePrivateKey(options.privateKey);
      if (dec.type !== 'Ed25519') throw new Error('Invalid key type for EdDSA');
      privateKey = dec.key;
    } else if (options.privateKey instanceof Uint8Array) {
      privateKey = options.privateKey;
    } else {
      throw new Error('Invalid private key format');
    }
    const proofValueBytes = await this.sign({ data: hashData, privateKey });
    delete (proofConfig as any)['@context'];
    return { ...proofConfig, proofValue: base58.encode(proofValueBytes) } as DataIntegrityProof;
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    try {
      const documentToVerify = { ...document };
      delete (documentToVerify as any).proof;
      const transformedData = await this.transform(documentToVerify, options);
      const hashData = await this.hash(transformedData, { '@context': document['@context'], ...proof }, options);
      const vmDoc = await options.documentLoader(proof.verificationMethod);
      const pk = vmDoc.document.publicKeyMultibase as string;
      const dec = multikey.decodePublicKey(pk);
      if (dec.type !== 'Ed25519') throw new Error('Invalid key type for EdDSA');
      const signature = base58.decode(proof.proofValue);
      const verified = await this.verify({ data: hashData, signature, publicKey: dec.key });
      return verified ? { verified: true } : { verified: false, errors: ['Proof verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown verification error'] };
    }
  }

  private static async createProofConfiguration(options: any): Promise<any> {
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
    return await canonize(document, { documentLoader: options.documentLoader });
  }

  private static async hash(transformedData: string, proofConfig: any, options: any): Promise<Uint8Array> {
    const canonicalProofConfig = await canonizeProof(proofConfig, { documentLoader: options.documentLoader });
    const proofConfigHash = await sha256Bytes(canonicalProofConfig);
    const documentHash = await sha256Bytes(transformedData);
    return new Uint8Array([...proofConfigHash, ...documentHash]);
  }

  static async sign({ data, privateKey }: { data: Uint8Array; privateKey: Uint8Array }): Promise<Uint8Array> {
    if (privateKey.length !== 32) {
      if (privateKey.length === 64) privateKey = privateKey.slice(32);
      else throw new Error('Invalid private key length');
    }
    const signature = await ed25519.signAsync(Buffer.from(data).toString('hex'), Buffer.from(privateKey).toString('hex'));
    return signature;
  }

  static async verify({ data, signature, publicKey }: { data: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }): Promise<boolean> {
    return await ed25519.verifyAsync(Buffer.from(signature).toString('hex'), Buffer.from(data).toString('hex'), Buffer.from(publicKey).toString('hex'));
  }
}

