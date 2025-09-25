export abstract class Signer {
  abstract sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer>;
  abstract verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean>;
}

import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';

// Ensure noble hash utils available in Node (unconditional assignment for coverage)
let sAny: any = secp256k1 as any;
let eAny: any = ed25519 as any;
sAny.utils = sAny.utils || {};
/* istanbul ignore next */
sAny.utils.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
  hmac(sha256, key, concatBytes(...msgs));
eAny.utils = eAny.utils || {};
/* istanbul ignore next */
eAny.utils.sha512Sync = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));

export class ES256KSigner extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const privateKey = Buffer.from(privateKeyMultibase.slice(1), 'base64url');
    const hash = sha256(data);
    const sigAny: any = await (secp256k1 as any).signAsync(hash as Uint8Array, privateKey as Uint8Array);
    const sigBytes: Uint8Array = sigAny instanceof Uint8Array
      ? sigAny
      : typeof sigAny?.toCompactRawBytes === 'function'
        ? sigAny.toCompactRawBytes()
        : typeof sigAny?.toRawBytes === 'function'
          ? sigAny.toRawBytes()
          : new Uint8Array(sigAny);
    return Buffer.from(sigBytes);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const publicKey = Buffer.from(publicKeyMultibase.slice(1), 'base64url');
    const hash = sha256(data);
    try {
      return secp256k1.verify(signature, hash, publicKey);
    } catch {
      /* istanbul ignore next */
      return false;
    }
  }
}

export class Ed25519Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const privateKey = Buffer.from(privateKeyMultibase.slice(1), 'base64url');
    const signature = await (ed25519 as any).signAsync(data, privateKey);
    return Buffer.from(signature);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const publicKey = Buffer.from(publicKeyMultibase.slice(1), 'base64url');
    try {
      return await (ed25519 as any).verifyAsync(signature, data, publicKey);
    } catch {
      /* istanbul ignore next */
      return false;
    }
  }
}

export class ES256Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    throw new Error('Not implemented');
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    throw new Error('Not implemented');
  }
}

export class Bls12381G2Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const sk = Buffer.from(privateKeyMultibase.slice(1), 'base64url');
    const sig = await bls.sign(data, sk);
    return Buffer.from(sig);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const pk = Buffer.from(publicKeyMultibase.slice(1), 'base64url');
    try {
      return await bls.verify(signature, data, pk);
    } catch {
      return false;
    }
  }
}


