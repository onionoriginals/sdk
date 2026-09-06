declare module 'jsonld';
declare module 'b58';

declare module '@digitalbazaar/bbs-signatures' {
  export const CIPHERSUITES: Record<string, unknown>;
  export function generateKeyPair(opts: { ciphersuite: string; seed?: Uint8Array }): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array }>;
  export function secretKeyToPublicKey(opts: { secretKey: Uint8Array; ciphersuite: string }): Promise<Uint8Array>;
  export function sign(opts: { ciphersuite: string; secretKey: Uint8Array; publicKey: Uint8Array; header?: Uint8Array; messages: Uint8Array[] }): Promise<Uint8Array>;
  export function verifySignature(opts: { ciphersuite: string; publicKey: Uint8Array; signature: Uint8Array; header?: Uint8Array; messages: Uint8Array[] }): Promise<boolean>;
  export function deriveProof(opts: { ciphersuite: string; publicKey: Uint8Array; signature: Uint8Array; header?: Uint8Array; presentationHeader?: Uint8Array; messages: Uint8Array[]; disclosedMessageIndexes: number[] }): Promise<Uint8Array>;
  export function verifyProof(opts: { ciphersuite: string; publicKey: Uint8Array; proof: Uint8Array; header?: Uint8Array; presentationHeader?: Uint8Array; disclosedMessages: Uint8Array[]; disclosedMessageIndexes: number[] }): Promise<boolean>;
}
// Global shims for non-DOM/node test environments
declare const global: Record<string, unknown> & typeof globalThis;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;

