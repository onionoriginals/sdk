import { Multikey, KeyType } from './Multikey';
import { base58, base64url, multibase, MULTICODEC_ED25519_PRIV_HEADER, MULTICODEC_ED25519_PUB_HEADER, multikey } from '../utils/encoding';
import type { DocumentLoader } from '../../common/interfaces';
import { createVerifyData } from '../utils/vcs';
import type { JsonWebKey2020, JsonWebKeyPair } from './JsonWebKey2020';
import { DataIntegrityProofManager, type DataIntegrityProof } from '../../vcs/v2/proofs/data-integrity';

export class Ed25519Signature2020LinkedDataProof {
  public type: string;
  public proofPurpose: string;
  public verificationMethod: string;
  public created: string;
  public cryptosuite: string;
  public proofValue?: string;
  public challenge?: string;
  public domain?: string;

  constructor(
    type: string,
    proofPurpose: string,
    cryptosuite: string,
    verificationMethod: string,
    created: string,
    proofValue?: string,
    challenge?: string,
    domain?: string
  ) {
    this.type = type;
    this.proofPurpose = proofPurpose;
    this.cryptosuite = cryptosuite;
    this.verificationMethod = verificationMethod;
    this.created = created;
    this.proofValue = proofValue;
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
    if (this.proofValue) json.proofValue = this.proofValue;
    if (this.challenge) json.challenge = this.challenge;
    if (this.domain) json.domain = this.domain;
    return json;
  }
}

export class Ed25519VerificationKey2020 {
  multikey: Multikey;

  constructor(id: string, controller: string, publicKeyMultibase: string, secretKeyMultibase?: string) {
    const publicKey = multikey.decode(MULTICODEC_ED25519_PUB_HEADER, publicKeyMultibase);
    const privateKey = secretKeyMultibase ? multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, secretKeyMultibase) : undefined;
    this.multikey = new Multikey(KeyType.Ed25519, id, controller, publicKey, privateKey);
  }

	get publicKey(): Uint8Array {
    return this.multikey.publicKey;
  }

	get privateKey(): Uint8Array | undefined {
    return this.multikey.privateKey;
  }

  get id(): string {
    return this.multikey.id;
  }

  get type(): string {
    return 'Ed25519VerificationKey2020';
  }

  get controller(): string {
    return this.multikey.controller;
  }

  get publicKeyMultibase(): string {
    return this.multikey.publicKeyMultibase;
  }

  get secretKeyMultibase(): string | undefined {
    return this.multikey.secretKeyMultibase;
  }

  static async generate(): Promise<Ed25519VerificationKey2020> {
    const generatedMultikey = await Multikey.generate(KeyType.Ed25519);
    return new Ed25519VerificationKey2020(
      generatedMultikey.id,
      generatedMultikey.controller,
      generatedMultikey.publicKeyMultibase,
      generatedMultikey.secretKeyMultibase
    );
  }

  static from(options: { id?: string, controller?: string, publicKeyBase58: string, privateKeyBase58?: string }): Ed25519VerificationKey2020 {
    const publicKeyMultibase = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, base58.decode(options.publicKeyBase58));
    const secretKeyMultibase = options.privateKeyBase58
      ? multikey.encode(MULTICODEC_ED25519_PRIV_HEADER, base58.decode(options.privateKeyBase58))
      : undefined;
    return new Ed25519VerificationKey2020(
      options.id ?? `#${publicKeyMultibase.slice(0, 8)}`,
      options.controller ?? `#${publicKeyMultibase.slice(0, 8)}`,
      publicKeyMultibase,
      secretKeyMultibase
    );
  }
	
	static fromBase58 = async (options: { id?: string, controller?: string, publicKeyBase58: string, privateKeyBase58?: string }) => {
		let publicKeyMultibase, secretKeyMultibase;
		publicKeyMultibase = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, base58.decode(options.publicKeyBase58))
		if (options.privateKeyBase58) {
			secretKeyMultibase = multikey.encode(MULTICODEC_ED25519_PRIV_HEADER, base58.decode(options.privateKeyBase58))
		}
		return new Ed25519VerificationKey2020(
			options.id ?? `#${publicKeyMultibase.slice(0, 8)}`,
			options.controller ?? `#${publicKeyMultibase.slice(0, 8)}`,
			publicKeyMultibase,
			secretKeyMultibase
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
		return new Ed25519VerificationKey2020(k.id, k.controller, publicKey, privateKey);
	};

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.multikey.sign(data);
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return this.multikey.verify(data, signature);
  }

	async export(
    options: {
      privateKey?: boolean;
      type: 'JsonWebKey2020';
    } = {
      privateKey: false,
      type: 'JsonWebKey2020'
    }
  ): Promise<JsonWebKey2020> {
		return this.multikey.export(options);
	}

  async createProof(
    document: any,
    purpose: string,
    documentLoader: DocumentLoader,
    options?: { domain?: string, challenge?: string }
  ): Promise<{context: string[], proof: DataIntegrityProof}> {
    if (!this.secretKeyMultibase) {
      throw new Error("No privateKey, Can't create proof");
    }
    const date = new Date().toISOString();
    
    if (!document['@context'].includes('https://w3id.org/security/data-integrity/v2')) {
      document['@context'] = [...document['@context'], 'https://w3id.org/security/data-integrity/v2'];
    }

    const proof = await DataIntegrityProofManager.createProof(document, {
      cryptosuite: 'eddsa-rdfc-2022',
      proofPurpose: purpose,
      type: 'DataIntegrityProof',
      created: date.slice(0, date.length - 5) + 'Z',
      privateKey: multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, this.secretKeyMultibase),
      verificationMethod: this.id,
      ...(options?.challenge && { challenge: options.challenge }),
      ...(options?.domain && { domain: options.domain }),
      documentLoader
    }) as DataIntegrityProof;
    return {context: document['@context'], proof}
  }

  async verifyProof(
    proof: DataIntegrityProof,
    document: any,
    documentLoader: DocumentLoader
  ): Promise<{ verified: boolean; errors?: string[] }> {
    try {
      const { proof: documentProof, ...doc } = document;
      // const verifyData = await createVerifyData({
      //   document: doc,
      //   proof: { '@context': doc['@context'], ...proof },
      //   documentLoader
      // });

      // const signature = multibase.decode(proof.proofValue ?? '');
      // const verified = await this.verify(verifyData, signature);
      const verified = await DataIntegrityProofManager.verifyProof(doc, proof, {documentLoader})

      if (!verified) {
        return { verified: false, errors: ['Invalid signature'] };
      }

      return { verified: true };
    } catch (error: any) {
      return { verified: false, errors: [error.message] };
    }
  }
}
