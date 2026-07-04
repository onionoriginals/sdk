import { base58 } from '@scure/base';
import * as ed25519 from '@noble/ed25519';
import { canonize, canonizeProof } from '../utils/jsonld.js';
import { multikey } from '../../crypto/Multikey.js';
import { sha256Bytes } from '../../utils/hash.js';

// Re-export canonical DataIntegrityProof from shared types
export type { DataIntegrityProof } from '../../types/proof.js';
import type { DataIntegrityProof } from '../../types/proof.js';

export interface VerificationResult {
  verified: boolean;
  errors?: string[];
}

export class EdDSACryptosuiteManager {

  static async createProof(document: any, options: any): Promise<DataIntegrityProof> {
    const proofConfig = await this.createProofConfiguration(options, document?.['@context']);
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
    delete (proofConfig)['@context'];
    // proofValue is multibase base58btc per the Data Integrity spec
    return { ...proofConfig, proofValue: `z${base58.encode(proofValueBytes)}` } as DataIntegrityProof;
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    try {
      const documentToVerify = { ...document };
      delete (documentToVerify).proof;
      const transformedData = await this.transform(documentToVerify, options);
      const hashData = await this.hash(
        transformedData,
        { '@context': document['@context'] ?? 'https://w3id.org/security/data-integrity/v2', ...proof },
        options
      );
      const vmDoc = await options.documentLoader(proof.verificationMethod);
      // Fail closed on retired keys. A verification method that has been
      // rotated out (`revoked`) or marked `compromised` is still published in
      // the DID document so verifiers can recognise it as no longer valid;
      // accepting a signature from it would let an attacker holding the old
      // private key forge credentials, defeating key rotation / compromise
      // recovery. Mirrors the CEL key resolver (src/cel/keyResolver.ts).
      const vm = vmDoc.document as { revoked?: unknown; compromised?: unknown };
      if (vm?.revoked) throw new Error('Verification method has been revoked');
      if (vm?.compromised) throw new Error('Verification method has been marked as compromised');
      const pk = vmDoc.document.publicKeyMultibase as string;
      const dec = multikey.decodePublicKey(pk);
      if (dec.type !== 'Ed25519') throw new Error('Invalid key type for EdDSA');
      if (typeof proof.proofValue !== 'string' || !proof.proofValue.startsWith('z')) {
        throw new Error('proofValue must be multibase base58btc (z-prefixed)');
      }
      const signature = base58.decode(proof.proofValue.slice(1));
      const verified = await this.verify({ data: hashData, signature, publicKey: dec.key });
      return verified ? { verified: true } : { verified: false, errors: ['Proof verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown verification error'] };
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private static async createProofConfiguration(options: any, documentContext?: unknown): Promise<any> {
    // Per eddsa-rdfc-2022, the proof configuration is canonicalized with the
    // secured document's @context so create and verify hash identical data.
    return {
      '@context': documentContext ?? 'https://w3id.org/security/data-integrity/v2',
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
      // A 64-byte Ed25519 secret key is seed(32) || publicKey(32); noble signs
      // from the 32-byte seed, which is the FIRST half. slice(32) took the
      // public-key half, producing signatures that never verify.
      if (privateKey.length === 64) privateKey = privateKey.slice(0, 32);
      else throw new Error('Invalid private key length');
    }
    const signature = await ed25519.signAsync(data, privateKey);
    return signature;
  }

  static async verify({ data, signature, publicKey }: { data: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }): Promise<boolean> {
    return await ed25519.verifyAsync(signature, data, publicKey);
  }
}

