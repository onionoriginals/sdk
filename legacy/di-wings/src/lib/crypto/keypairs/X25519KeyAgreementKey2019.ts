import { Multikey, KeyType } from './Multikey';
import { base58, base64url, multibase, MULTICODEC_X25519_PRIV_HEADER, MULTICODEC_X25519_PUB_HEADER, multikey } from '../utils/encoding';
import type { JsonWebKey2020 } from './JsonWebKey2020';

export class X25519KeyAgreementKey2019 {
  multikey: Multikey;

  constructor(id: string, controller: string, publicKeyBase58: string, privateKeyBase58?: string) {
    this.multikey = new Multikey(KeyType.X25519, id, controller, base58.decode(publicKeyBase58), privateKeyBase58 ? base58.decode(privateKeyBase58) : undefined);
  }

  get id(): string {
    return this.multikey.id;
  }

  get type(): string {
    return 'X25519KeyAgreementKey2019';
  }

  get controller(): string {
    return this.multikey.controller;
  }

  get publicKeyBase58(): string {
    return base58.encode(multikey.decode(MULTICODEC_X25519_PUB_HEADER, this.multikey.publicKeyMultibase));
  }

  get privateKeyBase58(): string | undefined {
    return this.multikey.secretKeyMultibase
      ? base58.encode(multikey.decode(MULTICODEC_X25519_PRIV_HEADER, this.multikey.secretKeyMultibase))
      : undefined;
  }

  static async generate(): Promise<X25519KeyAgreementKey2019> {
    const key = await Multikey.generate(KeyType.X25519);
    return new X25519KeyAgreementKey2019(
      key.id,
      key.controller,
      base58.encode(multikey.decode(MULTICODEC_X25519_PUB_HEADER, key.publicKeyMultibase)),
      key.secretKeyMultibase
        ? base58.encode(multikey.decode(MULTICODEC_X25519_PRIV_HEADER, key.secretKeyMultibase))
        : undefined
    );
  }

  static from(options: { id?: string, controller?: string, publicKeyBase58: string, privateKeyBase58?: string }): X25519KeyAgreementKey2019 {
    return new X25519KeyAgreementKey2019(
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
		return new X25519KeyAgreementKey2019(k.id, k.controller, publicKey, privateKey);
	};

  async deriveSecret(publicKey: X25519KeyAgreementKey2019): Promise<Uint8Array> {
    return this.multikey.deriveSecret(publicKey.multikey);
  }

  async encrypt(data: Uint8Array, recipientPublicKey: X25519KeyAgreementKey2019): Promise<Uint8Array> {
    const recipientMultikey = new Multikey(
      KeyType.X25519,
      recipientPublicKey.id,
      recipientPublicKey.controller,
      base58.decode(recipientPublicKey.publicKeyBase58)
    );
    return this.multikey.encrypt(data, recipientMultikey);
  }

  async decrypt(data: Uint8Array, senderPublicKey: X25519KeyAgreementKey2019): Promise<Uint8Array> {
    const senderMultikey = new Multikey(
      KeyType.X25519,
      senderPublicKey.id,
      senderPublicKey.controller,
      base58.decode(senderPublicKey.publicKeyBase58)
    );
    return this.multikey.decrypt(data, senderMultikey);
  }

  async export(options?: { privateKey?: boolean; type: 'JsonWebKey2020' }): Promise<JsonWebKey2020> {
    return this.multikey.export(options);
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      controller: this.controller,
      publicKeyBase58: this.publicKeyBase58
    };
  }
}