export abstract class Signer {
  abstract sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer>;
  abstract verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean>;
}

import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { concatBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';

export class ES256KSigner extends Signer {
  constructor() {
    super();
    // Configure noble hashes for Node environment
    const sAny: any = secp256k1 as any;
    const eAny: any = ed25519 as any;
    if (!sAny.utils.hmacSha256Sync) {
      sAny.utils.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
        hmac(sha256, key, concatBytes(...msgs));
    }
    if (!eAny.utils.sha512Sync) {
      eAny.utils.sha512Sync = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));
    }
  }
  // secp256k1 implementation for Bitcoin compatibility
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const privateKey = Buffer.from(privateKeyMultibase.slice(1), 'base64url');
    const hash = sha256(data);
    const signatureAny: any = await secp256k1.sign(hash as Uint8Array, privateKey as Uint8Array);
    const signatureBytes: Uint8Array = signatureAny instanceof Uint8Array
      ? signatureAny
      : typeof signatureAny?.toCompactRawBytes === 'function'
        ? signatureAny.toCompactRawBytes()
        : typeof signatureAny?.toRawBytes === 'function'
          ? signatureAny.toRawBytes()
          : new Uint8Array(signatureAny);
    return Buffer.from(signatureBytes);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const publicKey = Buffer.from(publicKeyMultibase.slice(1), 'base64url');
    const hash = sha256(data);
    return secp256k1.verify(signature, hash, publicKey);
  }
}

export class Ed25519Signer extends Signer {
  // EdDSA implementation
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
    return (ed25519 as any).verifyAsync(signature, data, publicKey);
  }
}

export class ES256Signer extends Signer {
  // ECDSA P-256 implementation
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    // Implement ECDSA P-256 signing with multibase private key
    throw new Error('Not implemented');
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    // Implement ECDSA P-256 verification with multibase public key
    throw new Error('Not implemented');
  }
}


