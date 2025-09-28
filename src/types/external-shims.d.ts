declare module 'cbor-js' {
  export function encode(value: any): ArrayBuffer | Uint8Array;
  export function decode(buffer: ArrayBufferLike): any;
  const _default: any;
  export default _default;
}

declare module 'multiformats/bases/base64' {
  export const base64url: {
    encode: (bytes: Uint8Array) => string;
    decode: (s: string) => Uint8Array;
  };
}

declare module 'jsonld';

declare module 'didwebvh-ts' {
  export function resolveDID(did: string): Promise<{ doc?: any } | null>;
}

declare module '@aviarytech/did-peer' {
  export type IDIDDocument = any;
  export type IDIDDocumentVerificationMethod = { id?: string; type: string; controller?: string; publicKeyMultibase?: string };
  export function create(numalgo: number, authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: any): Promise<string>;
  export function createNumAlgo0(authenticationKey: IDIDDocumentVerificationMethod): Promise<string>;
  export function createNumAlgo2(authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: any[]): Promise<string>;
  export function createNumAlgo4(authenticationKeys: IDIDDocumentVerificationMethod[], encryptionKeys?: IDIDDocumentVerificationMethod[], service?: any[]): Promise<string>;
  export function resolve(did: string, repository?: any): Promise<IDIDDocument>;
}

// Minimal node globals for tests without @types/node
declare const Buffer: any;

// Minimal jest globals for TS without @types/jest
declare function describe(name: string, fn: () => void): void;
declare function test(name: string, fn: () => any): void;
declare function it(name: string, fn: () => any): void;
declare function expect(actual: any): any;

// Global shims for non-DOM/node test environments
declare const global: any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;

