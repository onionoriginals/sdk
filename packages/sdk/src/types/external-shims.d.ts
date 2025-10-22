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

declare module 'didwebvh-ts' {
  export interface DIDDocument {
    '@context'?: string | string[];
    id: string;
    controller?: string | string[];
    verificationMethod?: Array<{
      id: string;
      type: string;
      controller: string;
      publicKeyMultibase?: string;
      publicKeyJwk?: Record<string, unknown>;
    }>;
    authentication?: Array<string | Record<string, unknown>>;
    assertionMethod?: Array<string | Record<string, unknown>>;
    keyAgreement?: Array<string | Record<string, unknown>>;
    capabilityInvocation?: Array<string | Record<string, unknown>>;
    capabilityDelegation?: Array<string | Record<string, unknown>>;
    service?: Array<{
      id: string;
      type: string;
      serviceEndpoint: string | Record<string, unknown>;
    }>;
    [key: string]: unknown;
  }
  export function resolveDID(did: string): Promise<{ doc?: DIDDocument } | null>;
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

