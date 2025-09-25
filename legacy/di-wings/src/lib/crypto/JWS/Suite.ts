import type { DocumentLoader, ProofJSON } from '..';
import { JsonWebKeyPair } from '../keypairs/JsonWebKey2020.js';
import { LinkedDataProof } from '../LDP/proof.js';
import { base64url } from '../utils/encoding.js';
import { sha256buffer } from '../utils/sha256.js';
import { Buffer } from 'buffer/index.js';
import jsonld from 'jsonld';

export { createJWSSigner } from '../JWS/createSigner.js';
export { createJWSVerifier } from '../JWS/createVerifier.js';

export interface ISuite {
  key?: JsonWebKeyPair;
  getVerificationMethod: (options: any) => Promise<JsonWebKeyPair>;
  deriveProof?: (options: any) => Promise<any>;
}

interface JWSProofJSON extends ProofJSON {
  jws?: string;
}

export class JsonWebSignature2020LinkedDataProof extends LinkedDataProof {
  public jws: string | null;

  constructor(
    type: string,
    proofPurpose: string,
    verificationMethod: string,
    created: string,
    challenge: string | null = null,
    domain: string | null = null,
    jws: string | null = null
  ) {
    super(type, proofPurpose, verificationMethod, challenge ?? undefined, domain ?? undefined, created);
    this.jws = jws;
  }

  toJSON(): JWSProofJSON {
    const json: JWSProofJSON = super.toJSON();

    if (this.jws) {
      json.jws = this.jws;
    }

    return json;
  }
}

export class JsonWebSignature2020Suite {
  public key: JsonWebKeyPair;
  public date: string;
  public type: string = 'JsonWebSignature2020';
  public context: string = 'https://w3c-ccg.github.io/lds-jws2020/contexts/lds-jws2020-v1.json';
  public verificationMethod?: string;
  public cryptosuite?: string;
  public useNativeCanonize: boolean = false;

  constructor(options: { key: JsonWebKeyPair; date?: string }) {
    this.date = options.date || new Date().toISOString();
    if (options.key) {
      this.key = options.key;
      this.verificationMethod = this.key.id;
    } else {
      throw new Error('key is required');
    }
  }

  async getVerificationMethod({ proof, documentLoader }: any) {
    let { verificationMethod } = proof;
    if (typeof verificationMethod === 'object') {
      verificationMethod = verificationMethod.id;
    }
    if (!verificationMethod) {
      throw new Error('No verification method found in proof');
    }

    const { document } = await documentLoader(verificationMethod);
    const result = document.verificationMethod.find((v: { id: string; }) => v.id === verificationMethod);
    if (!result || !result.controller) {
      throw new Error(`Verification method ${verificationMethod} not found.`);
    }

    return JsonWebKeyPair.fromJWK(result);
  }

  async canonize(input: any, { documentLoader }: any) {
    return await jsonld.canonize(input, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader,
      useNative: this.useNativeCanonize
    });
  }

  async canonizeProof(proof: any, { documentLoader }: any) {
    const { jws, ...rest } = proof;
    return await this.canonize(rest, {
      documentLoader
    });
  }

  async createVerifyData({ document, proof, documentLoader }: any) {
    const c14nProofOptions = await this.canonizeProof(proof, {
      documentLoader
    });
    const c14nDocument = await this.canonize(document, {
      documentLoader
    });
    return Buffer.concat([sha256buffer(c14nProofOptions), sha256buffer(c14nDocument)]);
  }

  async createProof(
    document: any,
    purpose: string,
    documentLoader: DocumentLoader,
    options?: { domain?: string; challenge?: string }
  ): Promise<{context: string[], proof: JWSProofJSON}> {
    if (!this.verificationMethod) {
      throw new Error("No verificationMethod, Can't create proof");
    }
    let proof = new JsonWebSignature2020LinkedDataProof(
      this.type,
      purpose,
      this.verificationMethod,
      new Date().toISOString(),
      options?.challenge ?? null,
      options?.domain ?? null,
      null
    );
    const verifyData = await this.createVerifyData({
      document: {...document, '@context': [...document['@context'], this.context]},
      proof: { '@context': [...document['@context'], this.context], ...proof.toJSON() },
      documentLoader
    });
    const sig = await this.sign(verifyData);
    proof.jws = sig;
    return {context: [...document['@context'], this.context], proof: proof.toJSON()};
  }

  async sign(verifyData: Uint8Array): Promise<string> {
    try {
      const key = await this.key.exportAsLD({ privateKey: true });
      const detachedJws = await key.sign!(verifyData);
      return (
        base64url.encode(Buffer.from(JSON.stringify({ b64: false, crit: ['b64'], alg: this.key.JWA }))) +
        '..' +
        base64url.encode(detachedJws)
      );
    } catch (e) {
      console.error('Failed to sign.', e);
      throw e;
    }
  }

	async verify(verifyData: Uint8Array, verificationMethod: JsonWebKeyPair, proof: { jws: string }): Promise<{ verified: boolean; error?: string }> {
		try {
			const [header, _, signature] = proof.jws.split('.');
			
			if (!header || !signature) {
				return { verified: false, error: "Invalid JWS format" };
			}

			const headerData = JSON.parse(Buffer.from(base64url.decode(header)).toString('utf-8'));
			
			if (!headerData.crit.includes('b64') || headerData.b64) {
				return { verified: false, error: "'b64' JWS header param must be false and in crit" };
			}
			
			if (!headerData.alg) {
				return { verified: false, error: "JWS header is missing 'alg' parameter" };
			}
			if (!this.key.JWA) {
				return { verified: false, error: "Key is missing JWA property" };
			}
			
			if (headerData.alg !== this.key.JWA) {
				return { verified: false, error: `JWA alg mismatch: received ${headerData.alg}, expected ${this.key.JWA}` };
			}
      const key = await verificationMethod.exportAsLD({ privateKey: false });
			const verified = await key.verify!(verifyData, base64url.decode(signature));
			return { verified };
		} catch (e: any) {
			console.error('Verification error:', e.message);
			return { verified: false, error: `Unexpected error during verification: ${e.message}` };
		}
	}

  async verifyProof(
    proof: JWSProofJSON,
    document: any,
    documentLoader: DocumentLoader,
    options: { expansionMap?: any; compactProof?: any } = {}
  ) {
    try {
      const verifyData = await this.createVerifyData({
        document,
        proof: { '@context': [...document['@context'], this.context], ...proof },
        documentLoader
      });

      const verificationMethod = await this.getVerificationMethod({
        proof,
        document,
        documentLoader,
        instance: true
      });
      if (!proof.jws) {
        return { verified: false, errors: ['jws not found in proof'] };
      }

      const { verified, error } = await this.verify(verifyData, verificationMethod, proof as {jws: string});
      if (!verified) {
        return { verified: false, errors: [error || 'Invalid signature'] };
      }

      const jwsProof = new JsonWebSignature2020LinkedDataProof(
        proof.type,
        proof.proofPurpose,
        proof.verificationMethod,
        proof.created,
        proof.challenge,
        proof.domain,
        proof.jws
      );

      const purposeValid = jwsProof.validate();

      if (!purposeValid) {
        throw new Error('Proof purpose not valid');
      }

      return { verified: true };
    } catch (error: any) {
      return { verified: false, errors: [error.message] };
    }
  }
}