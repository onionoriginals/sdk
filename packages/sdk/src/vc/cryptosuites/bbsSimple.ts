import { sha256 } from '@noble/hashes/sha2.js';

export type BbsKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export class BbsSimple {
  static readonly CIPHERSUITE = 'BLS12-381-SHA-256';

  static async sign(messages: Uint8Array[], keypair: BbsKeyPair, header?: Uint8Array): Promise<Uint8Array> {
    const headerBytes = header ?? new Uint8Array(sha256(new Uint8Array(0)));
    throw new Error('BbsSimple.sign is not implemented');
  }

  static async verify(messages: Uint8Array[], signature: Uint8Array, publicKey: Uint8Array, header?: Uint8Array): Promise<boolean> {
    const headerBytes = header ?? new Uint8Array(sha256(new Uint8Array(0)));
    throw new Error('BbsSimple.verify is not implemented');
  }

  // The methods below are unimplemented stubs. They exist so the BBS+
  // cryptosuite type-checks and any caller fails loudly rather than silently
  // producing fake selective-disclosure proofs. Implementing real BBS+ is a
  // separate effort with its own test plan.
  static generateKeyPair(): BbsKeyPair {
    throw new Error('BbsSimple.generateKeyPair is not implemented');
  }

  static async createProof(_options: {
    publicKey: Uint8Array;
    signature: Uint8Array;
    header?: Uint8Array;
    presentationHeader?: Uint8Array;
    messages: Uint8Array[];
    disclosedIndexes: number[];
  }): Promise<Uint8Array> {
    throw new Error('BbsSimple.createProof is not implemented');
  }

  static async verifyProof(_options: {
    publicKey: Uint8Array;
    proof: Uint8Array;
    header?: Uint8Array;
    presentationHeader?: Uint8Array;
    disclosedMessages: Uint8Array[];
    disclosedIndexes: number[];
    totalMessageCount: number;
  }): Promise<boolean> {
    throw new Error('BbsSimple.verifyProof is not implemented');
  }
}

