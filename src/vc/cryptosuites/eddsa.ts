import { base58btc } from 'multiformats/bases/base58';
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
    return { ...proofConfig, proofValue: base58btc.encode(proofValueBytes) } as DataIntegrityProof;
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
      const signature = base58btc.decode(proof.proofValue);
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
      ...(options.domain && { domain: options.domain }),
      ...(options.previousProof && { previousProof: options.previousProof })
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

  // Simple JSON Pointer selection to support basic selective disclosure use cases
  private static selectByJsonPointers(document: any, pointers?: string[]): any {
    if (!pointers || pointers.length === 0) {
      return document;
    }
    const result: any = { '@context': document['@context'] };
    for (const pointer of pointers) {
      if (!pointer || pointer[0] !== '/') continue;
      const segments = pointer.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      let srcParent: any = document;
      let dstParent: any = result;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        let key: any = seg;
        // numeric array index support
        if (/^\d+$/.test(seg)) {
          key = parseInt(seg, 10);
        }
        const srcVal = srcParent?.[key];
        if (srcVal === undefined) {
          break;
        }
        if (isLast) {
          // deep copy leaves
          if (Array.isArray(dstParent)) {
            dstParent[key] = JSON.parse(JSON.stringify(srcVal));
          } else {
            dstParent[seg] = JSON.parse(JSON.stringify(srcVal));
          }
        } else {
          // ensure container exists on destination
          const nextIsIndex = /^\d+$/.test(segments[i + 1] || '');
          const container = Array.isArray(srcVal) || nextIsIndex ? [] : (typeof srcVal === 'object' && srcVal !== null ? {} : {});
          if (Array.isArray(dstParent)) {
            if (dstParent[key] === undefined) dstParent[key] = container;
            dstParent = dstParent[key];
          } else {
            if (dstParent[seg] === undefined) dstParent[seg] = container;
            dstParent = dstParent[seg];
          }
          srcParent = srcVal;
        }
      }
    }
    return result;
  }

  // Derive a new proof over a selectively disclosed view of the document, chaining to previous proof
  static async deriveProof(document: any, options: any & { revealPaths?: string[]; previousProof?: string | string[] }): Promise<{ derivedDocument: any; proof: DataIntegrityProof }> {
    const view = this.selectByJsonPointers(document, options.revealPaths);
    const proof = await this.createProof(view, options);
    return { derivedDocument: view, proof };
  }
}

