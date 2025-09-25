import { Ed25519VerificationKey2020 } from './Ed25519VerificationKey2020';
import { base58, base64url, MULTICODEC_ED25519_PRIV_HEADER, MULTICODEC_ED25519_PUB_HEADER, multikey } from '../utils/encoding';
import type { DocumentLoader } from '../../common/interfaces';
import { createVerifyData } from '../utils/vcs';
import type { JsonWebKey2020 } from './JsonWebKey2020';
import type { Multikey } from './Multikey';
import type { DataIntegrityProof } from '../../vcs/v2/proofs/data-integrity';

export class Ed25519Signature2018LinkedDataProof {
  public type: string;
  public proofPurpose: string;
  public verificationMethod: string;
  public created: string;
  public jws?: string;
  public challenge?: string;
  public domain?: string;

  constructor(
    type: string,
    proofPurpose: string,
    verificationMethod: string,
    created: string,
    jws?: string,
    challenge?: string,
    domain?: string
  ) {
    this.type = type;
    this.proofPurpose = proofPurpose;
    this.verificationMethod = verificationMethod;
    this.created = created;
    this.jws = jws;
    this.challenge = challenge;
    this.domain = domain;
  }

  toJSON() {
    const json: any = {
      type: this.type,
      proofPurpose: this.proofPurpose,
      verificationMethod: this.verificationMethod,
      created: this.created,
    };
    if (this.jws) json.jws = this.jws;
    if (this.challenge) json.challenge = this.challenge;
    if (this.domain) json.domain = this.domain;
    return json;
  }
}

export class Ed25519VerificationKey2018 {
  private key2020: Ed25519VerificationKey2020;
	multikey: Multikey;

  constructor(id: string, controller: string, publicKeyBase58: string, privateKeyBase58?: string) {
    const publicKeyMultibase = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, base58.decode(publicKeyBase58));
    const privateKeyMultibase = privateKeyBase58
      ? multikey.encode(MULTICODEC_ED25519_PRIV_HEADER, base58.decode(privateKeyBase58))
      : undefined;
    this.key2020 = new Ed25519VerificationKey2020(id, controller, publicKeyMultibase, privateKeyMultibase);
		this.multikey = this.key2020.multikey;
  }

  get id(): string {
    return this.key2020.id;
  }

  get type(): string {
    return 'Ed25519VerificationKey2018';
  }

  get controller(): string {
    return this.key2020.controller;
  }

  get publicKeyBase58(): string {
    return base58.encode(multikey.decode(MULTICODEC_ED25519_PUB_HEADER, this.key2020.publicKeyMultibase));
  }

  get privateKeyBase58(): string | undefined {
    return this.key2020.secretKeyMultibase
      ? base58.encode(multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, this.key2020.secretKeyMultibase))
      : undefined;
  }

  static async generate(): Promise<Ed25519VerificationKey2018> {
    const key2020 = await Ed25519VerificationKey2020.generate();
    return new Ed25519VerificationKey2018(
      key2020.id,
      key2020.controller,
      base58.encode(multikey.decode(MULTICODEC_ED25519_PUB_HEADER, key2020.publicKeyMultibase)),
      key2020.secretKeyMultibase
        ? base58.encode(multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, key2020.secretKeyMultibase))
        : undefined
    );
  }

	static from(options: { id?: string, controller?: string, publicKeyBase58: string, privateKeyBase58?: string }): Ed25519VerificationKey2018 {
    return new Ed25519VerificationKey2018(
      options.id ?? `#${options.publicKeyBase58.slice(0, 8)}`,
      options.controller ?? `#${options.publicKeyBase58.slice(0, 8)}`,
      options.publicKeyBase58,
      options.privateKeyBase58
    );
  }

	static fromJWK = async (k: JsonWebKey2020) => {
		let publicKey, privateKey;
		if (!k.publicKeyJwk.x)
			throw new Error('Public Key Not found')
		publicKey = base58.encode(base64url.decode(k.publicKeyJwk.x));
		if (k.privateKeyJwk && k.privateKeyJwk.d) {
			privateKey = base58.encode(base64url.decode(k.privateKeyJwk.d));
		}
		return new Ed25519VerificationKey2018(k.id, k.controller, publicKey, privateKey);
	};

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.key2020.sign(data);
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return this.key2020.verify(data, signature);
  }

  async createProof(
    document: any,
    purpose: string,
    documentLoader: DocumentLoader,
    options?: { domain?: string, challenge?: string }
  ): Promise<{context: string[], proof: Ed25519Signature2018LinkedDataProof}> {
    if (!this.key2020.secretKeyMultibase) {
      throw new Error("No privateKey, Can't create proof");
    }
    const date = new Date().toISOString();
    const proof = new Ed25519Signature2018LinkedDataProof(
      'Ed25519Signature2018',
      purpose,
      this.id,
      date.slice(0, date.length - 5) + 'Z',
      undefined,
      options?.challenge,
      options?.domain
    );

    const verifyData = await createVerifyData({
      document,
      proof: { '@context': document['@context'], ...proof.toJSON() },
      documentLoader
    });

    const signature = await this.sign(verifyData);
    
    // Create JWS
    const header = {
      alg: 'EdDSA',
      b64: false,
      crit: ['b64']
    };

    const encodedHeader = base64url.encode(JSON.stringify(header));
    const encodedSignature = base64url.encode(signature);
    
    proof.jws = `${encodedHeader}..${encodedSignature}`;

    return {context: document['@context'], proof};
  }

  async verifyProof(
    proof: Ed25519Signature2018LinkedDataProof,
    document: any,
    documentLoader: DocumentLoader
  ): Promise<{ verified: boolean; errors?: string[] }> {
    try {
      const { proof: documentProof, ...doc } = document;
      const verifyData = await createVerifyData({
        document: doc,
        proof: { '@context': doc['@context'], ...proof },
        documentLoader
      });

      if (!proof.jws) {
        throw new Error('No jws found in proof');
      }

      const [encodedHeader, encodedSignature] = proof.jws.split('..');
      
      if (!encodedHeader || !encodedSignature) {
        throw new Error('Invalid JWS format');
      }

      const header = JSON.parse(base64url.decode(encodedHeader).toString());
      
      if (!header.b64 || !header.crit.includes('b64')) {
        throw new Error('Invalid JWS header');
      }

      const signature = base64url.decode(encodedSignature);
      const verified = await this.verify(verifyData, signature);

      if (!verified) {
        return { verified: false, errors: ['Invalid signature'] };
      }

      return { verified: true };
    } catch (error: any) {
      return { verified: false, errors: [error.message] };
    }
  }

  async export(options?: { privateKey?: boolean; type: 'JsonWebKey2020' }): Promise<any> {
    return this.key2020.export(options);
  }
}