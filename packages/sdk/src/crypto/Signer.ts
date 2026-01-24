// Initialize noble crypto libraries first (idempotent - safe to import multiple times)
import './noble-init.js';

export abstract class Signer {
  abstract sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer>;
  abstract verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean>;
}

import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { multikey } from './Multikey';

export class ES256KSigner extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }
    
    let decoded;
    try {
      decoded = multikey.decodePrivateKey(privateKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    
    if (decoded.type !== 'Secp256k1') {
      throw new Error('Invalid key type for ES256K');
    }
    
    const privateKey = decoded.key;
    const hash = sha256(data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const sigAny: any = await (secp256k1 as any).signAsync(hash, privateKey);
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const sigBytes: Uint8Array = sigAny instanceof Uint8Array
      ? sigAny
      : typeof sigAny?.toCompactRawBytes === 'function'
        ? sigAny.toCompactRawBytes()
        : typeof sigAny?.toRawBytes === 'function'
          ? sigAny.toRawBytes()
          : new Uint8Array(sigAny);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    return Buffer.from(sigBytes);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }

    let decoded;
    try {
      decoded = multikey.decodePublicKey(publicKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (decoded.type !== 'Secp256k1') {
      throw new Error('Invalid key type for ES256K');
    }

    const publicKey = decoded.key;
    const hash = sha256(data);
    try {
      return await Promise.resolve(secp256k1.verify(signature, hash, publicKey));
    } catch {
      return false;
    }
  }
}

export class Ed25519Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }
    
    let decoded;
    try {
      decoded = multikey.decodePrivateKey(privateKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    
    if (decoded.type !== 'Ed25519') {
      throw new Error('Invalid key type for Ed25519');
    }
    
    const privateKey = decoded.key;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const signature = await (ed25519 as any).signAsync(data, privateKey);
    return Buffer.from(signature);
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }
    
    let decoded;
    try {
      decoded = multikey.decodePublicKey(publicKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    
    if (decoded.type !== 'Ed25519') {
      throw new Error('Invalid key type for Ed25519');
    }
    
    const publicKey = decoded.key;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return await (ed25519 as any).verifyAsync(signature, data, publicKey);
    } catch {
      return false;
    }
  }
}

export class ES256Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }

    let decoded;
    try {
      decoded = multikey.decodePrivateKey(privateKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (decoded.type !== 'P256') {
      throw new Error('Invalid key type for ES256');
    }

    const privateKey = decoded.key;
    const hash = sha256(data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const sigAny: any = p256.sign(hash, privateKey);
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const sigBytes: Uint8Array = sigAny instanceof Uint8Array
      ? sigAny
      : typeof sigAny?.toCompactRawBytes === 'function'
        ? sigAny.toCompactRawBytes()
        : typeof sigAny?.toRawBytes === 'function'
          ? sigAny.toRawBytes()
          : new Uint8Array(sigAny);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    return await Promise.resolve(Buffer.from(sigBytes));
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }

    let decoded;
    try {
      decoded = multikey.decodePublicKey(publicKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (decoded.type !== 'P256') {
      throw new Error('Invalid key type for ES256');
    }

    const publicKey = decoded.key;
    const hash = sha256(data);
    try {
      return await Promise.resolve(p256.verify(signature, hash, publicKey));
    } catch {
      return false;
    }
  }
}

export class Bls12381G2Signer extends Signer {
  async sign(data: Buffer, privateKeyMultibase: string): Promise<Buffer> {
    if (!privateKeyMultibase || privateKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }

    let decoded;
    try {
      decoded = multikey.decodePrivateKey(privateKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (decoded.type !== 'Bls12381G2') {
      throw new Error('Invalid key type for Bls12381G2');
    }

    const sk = decoded.key;
    const sig = bls.sign(data, sk);
    return await Promise.resolve(Buffer.from(sig));
  }

  async verify(data: Buffer, signature: Buffer, publicKeyMultibase: string): Promise<boolean> {
    if (!publicKeyMultibase || publicKeyMultibase[0] !== 'z') {
      throw new Error('Invalid multibase key format. Keys must use multicodec headers.');
    }

    let decoded;
    try {
      decoded = multikey.decodePublicKey(publicKeyMultibase);
    } catch (error) {
      throw new Error(
        `Invalid multibase key format. Keys must use multicodec headers. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (decoded.type !== 'Bls12381G2') {
      throw new Error('Invalid key type for Bls12381G2');
    }

    const pk = decoded.key;
    try {
      return await Promise.resolve(bls.verify(signature, data, pk));
    } catch {
      return false;
    }
  }
}


