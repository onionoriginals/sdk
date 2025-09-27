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

// Removed: @digitalbazaar/bbs-signatures declarations no longer needed

declare module 'jsonld';

// Global shims for non-DOM/node test environments
declare const global: any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;

