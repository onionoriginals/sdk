/** Key custody types shared by the signer adapters. */

/** Multibase-encoded key pair. */
export interface KeyPair {
  privateKey: string; // multibase encoded
  publicKey: string; // multibase encoded
}

/** Minimal private-key custody contract keyed by verification method id. */
export interface KeyStore {
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}
