import { base58, base64url, MULTICODEC_ED25519_PUB_HEADER, MULTICODEC_X25519_PUB_HEADER, MULTICODEC_SECP256K1_PUB_HEADER, MULTICODEC_ED25519_PRIV_HEADER, MULTICODEC_X25519_PRIV_HEADER, MULTICODEC_SECP256K1_PRIV_HEADER, MULTICODEC_BLS12381_G2_PUB_HEADER, MULTICODEC_BLS12381_G2_PRIV_HEADER, multikey } from '../utils/encoding';
import * as ed25519 from '@stablelib/ed25519';
import * as x25519 from '@stablelib/x25519';
import * as secp from '@noble/secp256k1';
import { sha256Uint8Array } from '../utils/sha256';
import { XChaCha20Poly1305 } from '@stablelib/xchacha20poly1305';
import type { JsonWebKey2020 } from './JsonWebKey2020';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { bytesToNumberBE } from '@noble/curves/abstract/utils';

export enum KeyType {
  Ed25519 = 'Ed25519',
  X25519 = 'X25519',
  Secp256k1 = 'Secp256k1',
  Bls12381G2 = 'Bls12381G2',
}

export class Multikey {
  id: string;
  type: 'Multikey' = 'Multikey';
  controller: string;
  publicKeyMultibase: string;
  publicKey: Uint8Array;
  secretKeyMultibase?: string;
  privateKey?: Uint8Array;
  keyType: KeyType;
  private signer?: (data: Uint8Array) => Promise<Uint8Array>;
  private verifier?: (data: Uint8Array, signature: Uint8Array) => Promise<boolean>;

  constructor(keyType: KeyType, id: string, controller: string, publicKey: Uint8Array, privateKey?: Uint8Array) {
    this.keyType = keyType;
    this.id = id;
    this.controller = controller;
    this.publicKeyMultibase = Multikey.encodePublicKey(publicKey, keyType);
    this.publicKey = publicKey;
    this.verifier = this.createVerifier(publicKey);
    if (privateKey) {
      this.secretKeyMultibase = Multikey.encodePrivateKey(privateKey, keyType);
      this.privateKey = privateKey;
      this.signer = this.createSigner(privateKey);
    }
  }

  static async generate(keyType: KeyType): Promise<Multikey> {
    switch (keyType) {
      case KeyType.Bls12381G2: {
        const privateKey = bls.utils.randomPrivateKey();
        const publicKey = bls.G2.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(true);
        const blsPubMultibase = multikey.encode(MULTICODEC_BLS12381_G2_PUB_HEADER, publicKey);
        return new Multikey(
          keyType,
          `did:key:${blsPubMultibase}#${blsPubMultibase}`,
          `did:key:${blsPubMultibase}`,
          publicKey,
          privateKey
        );
      }
      case KeyType.Ed25519:
        const ed25519KeyPair = ed25519.generateKeyPair();
        const ed25519PubMultibase = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, ed25519KeyPair.publicKey);
        return new Multikey(
          KeyType.Ed25519,
          `did:key:${ed25519PubMultibase}#${ed25519PubMultibase}`,
          `did:key:${ed25519PubMultibase}`,
          ed25519KeyPair.publicKey,
          ed25519KeyPair.secretKey
        );
      case KeyType.X25519:
        const x25519KeyPair = x25519.generateKeyPair();
        const x25519PubMultibase = multikey.encode(MULTICODEC_X25519_PUB_HEADER, x25519KeyPair.publicKey);
        return new Multikey(
          KeyType.X25519,
          `did:key:${x25519PubMultibase}#${x25519PubMultibase}`,
          `did:key:${x25519PubMultibase}`,
          x25519KeyPair.publicKey,
          x25519KeyPair.secretKey
        );
      case KeyType.Secp256k1:
        const privateKey = secp.utils.randomPrivateKey();
        const publicKey = secp.getPublicKey(privateKey);
        const secp256k1PubMultibase = multikey.encode(MULTICODEC_SECP256K1_PUB_HEADER, publicKey);
        return new Multikey(
          KeyType.Secp256k1,
          `did:key:${secp256k1PubMultibase}#${secp256k1PubMultibase}`,
          `did:key:${secp256k1PubMultibase}`,
          publicKey,
          privateKey
        );
      default:
        throw new Error('Unsupported key type');
    }
  }

  private static fingerprintFromPublicKey(keyType: KeyType, publicKey: Uint8Array): string {
    let prefix: Uint8Array;
    switch (keyType) {
      case KeyType.Ed25519:
        prefix = MULTICODEC_ED25519_PUB_HEADER;
        break;
      case KeyType.X25519:
        prefix = MULTICODEC_X25519_PUB_HEADER;
        break;
      case KeyType.Secp256k1:
        prefix = MULTICODEC_SECP256K1_PUB_HEADER;
        break;
      case KeyType.Bls12381G2:
        prefix = MULTICODEC_BLS12381_G2_PUB_HEADER;
        break;
      default:
        throw new Error('Unsupported key type');
    }
    const fullKey = new Uint8Array(prefix.length + publicKey.length);
    fullKey.set(prefix);
    fullKey.set(publicKey, prefix.length);
    return 'z' + base58.encode(fullKey);
  }

  private createSigner(privateKey: Uint8Array) {
    switch (this.keyType) {
      case KeyType.Ed25519:
        return async (data: Uint8Array) => ed25519.sign(privateKey, data);
      case KeyType.Secp256k1:
        return async (data: Uint8Array) => {
          const msgHash = sha256Uint8Array(data);
          return secp.sign(msgHash, privateKey).toCompactRawBytes();
        };
      case KeyType.X25519:
        return async (data: Uint8Array) => {
          throw new Error('X25519 keys cannot be used for signing');
        }
      case KeyType.Bls12381G2:
        return async (data: Uint8Array) => {
          const msgHash = sha256Uint8Array(data);
          const h = bls.G1.hashToCurve(msgHash);
          const P = bls.G1.ProjectivePoint.fromAffine(h.toAffine());
          const sk = bytesToNumberBE(privateKey) % bls.params.r;
          return P.multiply(sk).toRawBytes(true);
        };
      default:
        throw new Error('Unsupported key type');
    }
  }

  private createVerifier(publicKey: Uint8Array) {
    switch (this.keyType) {
      case KeyType.Ed25519:
        return async (data: Uint8Array, signature: Uint8Array) => ed25519.verify(publicKey, data, signature);
      case KeyType.Secp256k1:
        return async (data: Uint8Array, signature: Uint8Array) => {
          const msgHash = sha256Uint8Array(data);
          return secp.verify(signature, msgHash, publicKey);
        };
      case KeyType.X25519:
        return async (data: Uint8Array, signature: Uint8Array) => {
          throw new Error('X25519 keys cannot be used for verification');
        }
      case KeyType.Bls12381G2:
        return async (data: Uint8Array, signature: Uint8Array) => {
          try {
            const msgHash = sha256Uint8Array(data);
            const h = bls.G1.hashToCurve(msgHash);
            const P = bls.G1.ProjectivePoint.fromAffine(h.toAffine());
            const P2 = bls.G2.ProjectivePoint.fromHex(publicKey);
            const sig = bls.G1.ProjectivePoint.fromHex(signature);
            
            const lhs = bls.pairing(sig, bls.G2.ProjectivePoint.BASE);
            const rhs = bls.pairing(P, P2);
            
            return bls.fields.Fp12.eql(lhs, rhs);
          } catch (error) {
            return false;
          }
        };
      default:
        throw new Error('Unsupported key type');
    }
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (!this.signer) {
      throw new Error('No private key available for signing');
    }
    return this.signer(data);
  }

  async verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    if (!this.verifier) {
      throw new Error('No public key available for verification');
    }
    return this.verifier(data, signature);
  }

  async deriveSecret(peerKey: Multikey): Promise<Uint8Array> {
    if (this.keyType !== KeyType.X25519 || peerKey.keyType !== KeyType.X25519) {
      throw new Error('Secret derivation is only supported for X25519 keys');
    }
    if (!this.secretKeyMultibase) {
      throw new Error('No private key available for deriving secret');
    }
    const privateKey = Multikey.decodePrivateKey(this.secretKeyMultibase).privateKey;
    const peerPublicKey = Multikey.decodePublicKey(peerKey.publicKeyMultibase).publicKey;
    return x25519.sharedKey(privateKey, peerPublicKey);
  }

  async encrypt(data: Uint8Array, recipientPublicKey: Multikey): Promise<Uint8Array> {
    if (this.keyType !== KeyType.X25519 || recipientPublicKey.keyType !== KeyType.X25519) {
      throw new Error('Encryption is only supported for X25519 keys');
    }
    const sharedSecret = await this.deriveSecret(recipientPublicKey);
    const cipher = new XChaCha20Poly1305(sharedSecret);
    const nonce = x25519.generateKeyPair().publicKey.subarray(0, 24); // Use first 24 bytes as nonce
    return cipher.seal(nonce, data);
  }

  async decrypt(data: Uint8Array, senderPublicKey: Multikey): Promise<Uint8Array> {
    if (this.keyType !== KeyType.X25519 || senderPublicKey.keyType !== KeyType.X25519) {
      throw new Error('Decryption is only supported for X25519 keys');
    }
    const sharedSecret = await this.deriveSecret(senderPublicKey);
    const cipher = new XChaCha20Poly1305(sharedSecret);
    const nonce = data.subarray(0, 24);
    const ciphertext = data.subarray(24);
    const decrypted = cipher.open(nonce, ciphertext);
    if (!decrypted) {
      throw new Error('Decryption failed');
    }
    return decrypted;
  }

  static encodePublicKey(publicKey: Uint8Array, keyType: KeyType): string {
    let header: Uint8Array;
    switch (keyType) {
      case KeyType.Ed25519:
        header = MULTICODEC_ED25519_PUB_HEADER;
        break;
      case KeyType.X25519:
        header = MULTICODEC_X25519_PUB_HEADER;
        break;
      case KeyType.Secp256k1:
        header = MULTICODEC_SECP256K1_PUB_HEADER;
        break;
      case KeyType.Bls12381G2:
        header = MULTICODEC_BLS12381_G2_PUB_HEADER;
        break;
      default:
        throw new Error('Unsupported key type');
    }
    return multikey.encode(header, publicKey);
  }

  static encodePrivateKey(privateKey: Uint8Array, keyType: KeyType): string {
    let header: Uint8Array;
    switch (keyType) {
      case KeyType.Ed25519:
        header = MULTICODEC_ED25519_PRIV_HEADER;
        break;
      case KeyType.X25519:
        header = MULTICODEC_X25519_PRIV_HEADER;
        break;
      case KeyType.Secp256k1:
        header = MULTICODEC_SECP256K1_PRIV_HEADER;
        break;
      case KeyType.Bls12381G2:
        header = MULTICODEC_BLS12381_G2_PRIV_HEADER;
        break;
      default:
        throw new Error('Unsupported key type');
    }
    return multikey.encode(header, privateKey);
  }

  static decodePublicKey(publicKeyMultibase: string): { keyType: KeyType; publicKey: Uint8Array } {
    if (!publicKeyMultibase.startsWith('z')) {
      throw new Error('Invalid Multibase encoding');
    }
    const decoded = base58.decode(publicKeyMultibase.slice(1));
    const header = decoded.slice(0, 2);
    const publicKey = decoded.slice(2);

    if (header[0] === MULTICODEC_ED25519_PUB_HEADER[0] && header[1] === MULTICODEC_ED25519_PUB_HEADER[1]) {
      return { keyType: KeyType.Ed25519, publicKey };
    } else if (header[0] === MULTICODEC_X25519_PUB_HEADER[0] && header[1] === MULTICODEC_X25519_PUB_HEADER[1]) {
      return { keyType: KeyType.X25519, publicKey };
    } else if (header[0] === MULTICODEC_SECP256K1_PUB_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PUB_HEADER[1]) {
      return { keyType: KeyType.Secp256k1, publicKey };
    } else if (header[0] === MULTICODEC_BLS12381_G2_PUB_HEADER[0] && header[1] === MULTICODEC_BLS12381_G2_PUB_HEADER[1]) {
      return { keyType: KeyType.Bls12381G2, publicKey };
    } else {
      throw new Error('Unsupported key type');
    }
  }

  static decodePrivateKey(secretKeyMultibase: string): { keyType: KeyType; privateKey: Uint8Array } {
    if (!secretKeyMultibase.startsWith('z')) {
      throw new Error('Invalid Multibase encoding');
    }
    const decoded = base58.decode(secretKeyMultibase.slice(1));
    const header = decoded.slice(0, 2);
    const privateKey = decoded.slice(2);

    if (header[0] === MULTICODEC_ED25519_PRIV_HEADER[0] && header[1] === MULTICODEC_ED25519_PRIV_HEADER[1]) {
      return { keyType: KeyType.Ed25519, privateKey };
    } else if (header[0] === MULTICODEC_X25519_PRIV_HEADER[0] && header[1] === MULTICODEC_X25519_PRIV_HEADER[1]) {
      return { keyType: KeyType.X25519, privateKey };
    } else if (header[0] === MULTICODEC_SECP256K1_PRIV_HEADER[0] && header[1] === MULTICODEC_SECP256K1_PRIV_HEADER[1]) {
      return { keyType: KeyType.Secp256k1, privateKey };
    } else if (header[0] === MULTICODEC_BLS12381_G2_PRIV_HEADER[0] && header[1] === MULTICODEC_BLS12381_G2_PRIV_HEADER[1]) {
      return { keyType: KeyType.Bls12381G2, privateKey };
    } else {
      throw new Error('Unsupported key type');
    }
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
    let publicKeyJwk: any;
    let privateKeyJwk: any;

    const publicKey = Multikey.decodePublicKey(this.publicKeyMultibase).publicKey;
    const privateKey = this.secretKeyMultibase ? Multikey.decodePrivateKey(this.secretKeyMultibase).privateKey : undefined;

    switch (this.keyType) {
      case KeyType.Ed25519:
      case KeyType.X25519:
        publicKeyJwk = {
          kty: 'OKP',
          crv: this.keyType === KeyType.Ed25519 ? 'Ed25519' : 'X25519',
          x: base64url.encode(publicKey)
        };
        if (options.privateKey && privateKey) {
          privateKeyJwk = {
            ...publicKeyJwk,
            d: base64url.encode(privateKey)
          };
        }
        break;
      case KeyType.Secp256k1:
        const point = secp.ProjectivePoint.fromHex(secp.etc.bytesToHex(publicKey));
        publicKeyJwk = {
          kty: 'EC',
          crv: 'secp256k1',
          x: base64url.encode(secp.etc.numberToBytesBE(point.x)),
          y: base64url.encode(secp.etc.numberToBytesBE(point.y))
        };
        if (options.privateKey && privateKey) {
          privateKeyJwk = {
            ...publicKeyJwk,
            d: base64url.encode(privateKey)
          };
        }
        break;
      default:
        throw new Error('Unsupported key type');
    }

    return {
      id: this.id,
      type: 'JsonWebKey2020',
      controller: this.controller,
      publicKeyJwk,
      privateKeyJwk
    };
  }

  toJSON() {
    const json: any = {
      '@context': ['https://w3id.org/security/multikey/v1'],
      id: this.id,
      type: this.type,
      controller: this.controller,
      publicKeyMultibase: this.publicKeyMultibase,
    };
    if (this.secretKeyMultibase) {
      json.secretKeyMultibase = this.secretKeyMultibase;
    }
    return json;
  }

  static fromMultibase({
    id,
    controller,
    publicKeyMultibase,
    secretKeyMultibase
  }: {
    id: string;
    controller: string;
    publicKeyMultibase: string;
    secretKeyMultibase?: string;
  }): Multikey {
    const { keyType, publicKey } = Multikey.decodePublicKey(publicKeyMultibase);
    let privateKey: Uint8Array | undefined;

    if (secretKeyMultibase) {
      const decodedPrivateKey = Multikey.decodePrivateKey(secretKeyMultibase);
      if (decodedPrivateKey.keyType !== keyType) {
        throw new Error('Public and private key types do not match');
      }
      privateKey = decodedPrivateKey.privateKey;
    }

    return new Multikey(keyType, id, controller, publicKey, privateKey);
  }

  static fromSecretKey(secretKeyMultibase: string): Multikey {
    const { keyType, privateKey } = Multikey.decodePrivateKey(secretKeyMultibase);
    let publicKey: Uint8Array;

    switch (keyType) {
      case KeyType.Ed25519:
        publicKey = ed25519.extractPublicKeyFromSecretKey(privateKey);
        break;
      case KeyType.X25519:
        throw new Error('X25519 keys not implemented yet');
        // publicKey = x25519.generateKeyPair(privateKey).publicKey;
        break;
      case KeyType.Secp256k1:
        publicKey = secp.getPublicKey(privateKey);
        break;
      case KeyType.Bls12381G2:
        publicKey = bls.G2.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(true);
        break;
      default:
        throw new Error('Unsupported key type');
    }

    const publicKeyMultibase = Multikey.encodePublicKey(publicKey, keyType);
    return new Multikey(
      keyType,
      `did:key:${publicKeyMultibase}#${publicKeyMultibase}`,
      `did:key:${publicKeyMultibase}`,
      publicKey,
      privateKey
    );
  }
}
