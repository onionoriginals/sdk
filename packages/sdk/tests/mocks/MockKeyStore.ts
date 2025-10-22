import { KeyStore } from '../../src/types';

/**
 * MockKeyStore is a simple in-memory implementation of the KeyStore interface
 * for testing purposes.
 */
export class MockKeyStore implements KeyStore {
  private keys: Map<string, string> = new Map();

  async getPrivateKey(verificationMethodId: string): Promise<string | null> {
    return this.keys.get(verificationMethodId) || null;
  }

  async setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void> {
    this.keys.set(verificationMethodId, privateKey);
  }

  /**
   * Helper method for testing: clear all stored keys
   */
  clear(): void {
    this.keys.clear();
  }

  /**
   * Helper method for testing: get all stored keys
   */
  getAllKeys(): Map<string, string> {
    return new Map(this.keys);
  }

  /**
   * Helper method: get all verification method IDs
   */
  getAllVerificationMethodIds(): string[] {
    return Array.from(this.keys.keys());
  }
}
