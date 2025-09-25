import { Multikey, KeyType } from './Multikey';
import { base58, multibase, MULTICODEC_X25519_PRIV_HEADER, MULTICODEC_X25519_PUB_HEADER, multikey } from '../utils/encoding';
import * as x25519 from '@stablelib/x25519';
import { X25519KeyAgreementKey2019 } from './X25519KeyAgreementKey2019';

export class X25519KeyAgreementKey2020 {
  multikey: Multikey;

  constructor(id: string, controller: string, publicKeyMultibase: string, privateKeyMultibase?: string) {
    const publicKey = multikey.decode(MULTICODEC_X25519_PUB_HEADER, publicKeyMultibase);
    const privateKey = privateKeyMultibase ? multikey.decode(MULTICODEC_X25519_PRIV_HEADER, privateKeyMultibase) : undefined;
    this.multikey = new Multikey(KeyType.X25519, id, controller, publicKey, privateKey);
  }

  get id(): string {
    return this.multikey.id;
  }
  
  get type(): string {
    return 'X25519KeyAgreementKey2020';
  }

  get controller(): string {
    return this.multikey.controller;
  }

  get publicKeyMultibase(): string {
    return this.multikey.publicKeyMultibase;
  }

  get privateKeyMultibase(): string | undefined {
    return this.multikey.secretKeyMultibase;
  }

	get publicKey(): Uint8Array {
    return this.multikey.publicKey;
  }

	get privateKey(): Uint8Array | undefined {
    return this.multikey.privateKey;
  }

  static async generate(): Promise<X25519KeyAgreementKey2020> {
    const keyPair = x25519.generateKeyPair();
    const publicKeyMultibase = multikey.encode(MULTICODEC_X25519_PUB_HEADER, keyPair.publicKey);
    const privateKeyMultibase = multikey.encode(MULTICODEC_X25519_PRIV_HEADER, keyPair.secretKey);
    const fingerprint = publicKeyMultibase;
    const controller = `did:key:${fingerprint}`;
    const id = `${controller}#${fingerprint}`;
    return new X25519KeyAgreementKey2020(id, controller, publicKeyMultibase, privateKeyMultibase);
  }

	static from(options: { id?: string, controller?: string, publicKeyBase58?: string, privateKeyBase58?: string, publicKeyMultibase?: string, privateKeyMultibase?: string }): X25519KeyAgreementKey2020 {
    const publicKeyMultibase = options.publicKeyMultibase ?? multikey.encode(MULTICODEC_X25519_PUB_HEADER, base58.decode(options.publicKeyBase58 as string));
    let privateKeyMultibase = options.privateKeyMultibase;
    if (!privateKeyMultibase) {
      privateKeyMultibase = options.privateKeyBase58
      ? multikey.encode(MULTICODEC_X25519_PRIV_HEADER, base58.decode(options.privateKeyBase58 as string))
      : undefined;
    }
    return new X25519KeyAgreementKey2020(
      options.id ?? `#${publicKeyMultibase.slice(0, 8)}`,
      options.controller ?? `#${publicKeyMultibase.slice(0, 8)}`,
      publicKeyMultibase,
      privateKeyMultibase
    );
  }

  async deriveSecret(publicKey: X25519KeyAgreementKey2020): Promise<Uint8Array> {
    if (!this.multikey.secretKeyMultibase) {
      throw new Error('No private key available for deriving secret');
    }
    // const privateKey = multikey.decode(MULTICODEC_X25519_PRIV_HEADER, this.multikey.privateKeyMultibase);
    // const peerPublicKey = multikey.decode(MULTICODEC_X25519_PUB_HEADER, publicKey.publicKeyMultibase);
    return this.multikey.deriveSecret(publicKey.multikey);
    // return x25519.sharedKey(privateKey, peerPublicKey);
  }

  async export(options?: { privateKey?: boolean; type: 'JsonWebKey2020' }): Promise<any> {
    return this.multikey.export(options);
  }
}