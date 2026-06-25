declare module 'cbor-js' {
  export function encode(value: unknown): ArrayBuffer | Uint8Array;
  export function decode(buffer: ArrayBufferLike): unknown;
  const _default: {
    encode: typeof encode;
    decode: typeof decode;
  };
  export default _default;
}

declare module 'multiformats/bases/base64' {
  export const base64url: {
    encode: (bytes: Uint8Array) => string;
    decode: (s: string) => Uint8Array;
  };
}

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
declare module '@aviarytech/did-peer' {
  export interface ServiceEndpoint {
    id: string;
    type: string;
    serviceEndpoint: string | Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface IDIDDocument {
    '@context'?: string | string[];
    id: string;
    controller?: string | string[];
    verificationMethod?: IDIDDocumentVerificationMethod[];
    authentication?: Array<string | IDIDDocumentVerificationMethod>;
    assertionMethod?: Array<string | IDIDDocumentVerificationMethod>;
    keyAgreement?: Array<string | IDIDDocumentVerificationMethod>;
    capabilityInvocation?: Array<string | IDIDDocumentVerificationMethod>;
    capabilityDelegation?: Array<string | IDIDDocumentVerificationMethod>;
    service?: ServiceEndpoint[];
    [key: string]: unknown;
  }

  export type IDIDDocumentVerificationMethod = { id?: string; type: string; controller?: string; publicKeyMultibase?: string };
  export function create(numalgo: number, authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: ServiceEndpoint): Promise<string>;
  export function createNumAlgo0(authenticationKey: IDIDDocumentVerificationMethod): Promise<string>;
  export function createNumAlgo2(authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: ServiceEndpoint[]): Promise<string>;
  export function createNumAlgo4(authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: ServiceEndpoint[]): Promise<string>;
  export function resolve(did: string, repository?: Record<string, unknown>): Promise<IDIDDocument>;
}

// Global shims for non-DOM/node test environments
declare const global: Record<string, unknown> & typeof globalThis;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;

