import * as bbs from '@digitalbazaar/bbs-signatures';
import { sha256 } from '@noble/hashes/sha2.js';

export type BbsKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export class BbsSimple {
  static readonly CIPHERSUITE = 'BLS12-381-SHA-256';

  static async sign(messages: Uint8Array[], keypair: BbsKeyPair, header?: Uint8Array): Promise<Uint8Array> {
    const headerBytes = header ?? new Uint8Array(sha256(new Uint8Array(0)));
    return await bbs.sign({
      ciphersuite: BbsSimple.CIPHERSUITE,
      secretKey: keypair.privateKey,
      publicKey: keypair.publicKey,
      header: headerBytes,
      messages
    });
  }

  static async verify(messages: Uint8Array[], signature: Uint8Array, publicKey: Uint8Array, header?: Uint8Array): Promise<boolean> {
    const headerBytes = header ?? new Uint8Array(sha256(new Uint8Array(0)));
    return await bbs.verifySignature({
      ciphersuite: BbsSimple.CIPHERSUITE,
      publicKey,
      signature,
      header: headerBytes,
      messages
    });
  }
}

