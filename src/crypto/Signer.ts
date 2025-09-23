export abstract class Signer {
  abstract sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer>;
  abstract verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean>;
}

import { createHash } from 'crypto';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { base58btc } from 'multiformats/bases/base58';

export class ES256KSigner extends Signer {
  // secp256k1 implementation for Bitcoin compatibility
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const privateKey = base58btc.decode(privateKeyMultibase);
    const hash = createHash('sha256').update(data).digest();
    const signature = await secp256k1.sign(hash, privateKey, { der: false });
    return Buffer.from(signature);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const publicKey = base58btc.decode(publicKeyMultibase);
    const hash = createHash('sha256').update(data).digest();
    return secp256k1.verify(signature, hash, publicKey);
  }
}

export class Ed25519Signer extends Signer {
  // EdDSA implementation
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase private key');
    }
    const privateKey = base58btc.decode(privateKeyMultibase);
    const signature = await ed25519.sign(data, privateKey);
    return Buffer.from(signature);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase public key');
    }
    const publicKey = base58btc.decode(publicKeyMultibase);
    return ed25519.verify(signature, data, publicKey);
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


