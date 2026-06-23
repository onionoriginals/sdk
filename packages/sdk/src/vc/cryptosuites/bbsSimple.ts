export type BbsKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export class BbsSimple {
  static readonly CIPHERSUITE = 'BLS12-381-SHA-256';

  // eslint-disable-next-line @typescript-eslint/require-await
  static async sign(_messages: Uint8Array[], _keypair: BbsKeyPair, _header?: Uint8Array): Promise<Uint8Array> {
    throw new Error('BbsSimple.sign is not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  static async verify(_messages: Uint8Array[], _signature: Uint8Array, _publicKey: Uint8Array, _header?: Uint8Array): Promise<boolean> {
    throw new Error('BbsSimple.verify is not implemented');
  }

  // The methods below are unimplemented stubs. They exist so the BBS+
  // cryptosuite type-checks and any caller fails loudly rather than silently
  // producing fake selective-disclosure proofs. Implementing real BBS+ is a
  // separate effort with its own test plan.
  static generateKeyPair(): BbsKeyPair {
    throw new Error('BbsSimple.generateKeyPair is not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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

  // eslint-disable-next-line @typescript-eslint/require-await
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

