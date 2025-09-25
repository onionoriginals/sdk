import { Multikey, KeyType } from './Multikey';
import { base58, MULTICODEC_SECP256K1_PUB_HEADER, MULTICODEC_SECP256K1_PRIV_HEADER, multikey } from '../utils/encoding';
import type { JsonWebKey2020 } from './JsonWebKey2020';
import { HDKey } from "@scure/bip32";
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';
import { Buffer } from 'buffer/index.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

export class Secp256k1KeyPair {
  multikey: Multikey;

  constructor(id: string, controller: string, publicKeyBase58: string, privateKeyBase58?: string) {
    this.multikey = new Multikey(
      KeyType.Secp256k1,
      id,
      controller,
      base58.decode(publicKeyBase58),
      privateKeyBase58 ? base58.decode(privateKeyBase58) : undefined
    );
  }

  get id(): string {
    return this.multikey.id;
  }

  get type(): string {
    return 'EcdsaSecp256k1VerificationKey2019';
  }

  get controller(): string {
    return this.multikey.controller;
  }

	get publicKey(): Uint8Array {
    return this.multikey.publicKey;
  }

	get privateKey(): Uint8Array | undefined {
    return this.multikey.privateKey;
  }

  get publicKeyBase58(): string {
    return base58.encode(multikey.decode(MULTICODEC_SECP256K1_PUB_HEADER, this.multikey.publicKeyMultibase));
  }

  get privateKeyBase58(): string | undefined {
    return this.multikey.secretKeyMultibase
      ? base58.encode(multikey.decode(MULTICODEC_SECP256K1_PRIV_HEADER, this.multikey.secretKeyMultibase))
      : undefined;
  }

  static async generate(): Promise<Secp256k1KeyPair> {
    const key = await Multikey.generate(KeyType.Secp256k1);
    return new Secp256k1KeyPair(
      key.id,
      key.controller,
      base58.encode(multikey.decode(MULTICODEC_SECP256K1_PUB_HEADER, key.publicKeyMultibase)),
      key.secretKeyMultibase
        ? base58.encode(multikey.decode(MULTICODEC_SECP256K1_PRIV_HEADER, key.secretKeyMultibase))
        : undefined
    );
  }

  static from(options: { id?: string, controller?: string, publicKeyBase58: string, privateKeyBase58?: string }): Secp256k1KeyPair {
    return new Secp256k1KeyPair(
      options.id ?? `#${options.publicKeyBase58.slice(0, 8)}`,
      options.controller ?? `#${options.publicKeyBase58.slice(0, 8)}`,
      options.publicKeyBase58,
      options.privateKeyBase58
    );
  }

  static async fromJWK(k: JsonWebKey2020): Promise<Secp256k1KeyPair> {
    const { x, y } = k.publicKeyJwk;
    if (!x || !y) throw new Error('Invalid public key');
    const xInt = BigInt('0x' + Buffer.from(x, 'base64').toString('hex'));
    const yInt = BigInt('0x' + Buffer.from(y, 'base64').toString('hex'));
    const pubKey = secp.ProjectivePoint.fromAffine({x: xInt, y: yInt}).toRawBytes();
    let privKey;
    if (k.privateKeyJwk && k.privateKeyJwk.d) {
      privKey = Buffer.from(k.privateKeyJwk.d, 'base64');
    }
    return new Secp256k1KeyPair(k.id, k.controller, base58.encode(pubKey), privKey ? base58.encode(privKey) : undefined);
  }

  static async fromXpub(xpub: string): Promise<Secp256k1KeyPair | null> {
    const hd = HDKey.fromExtendedKey(xpub);
    if (hd.publicKey) {
      const fingerprint = multikey.encode(MULTICODEC_SECP256K1_PUB_HEADER, hd.publicKey);
      const controller = `did:key:${fingerprint}`;
      const id = `${controller}#${fingerprint}`;
      return new Secp256k1KeyPair(id, controller, base58.encode(hd.publicKey));
    }
    return null;
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.multikey.sign(data);
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return this.multikey.verify(data, signature);
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

