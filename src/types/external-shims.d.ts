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

declare module '@digitalbazaar/bbs-signatures' {
  export function sign(args: {
    ciphersuite: string;
    secretKey: Uint8Array;
    publicKey: Uint8Array;
    header: Uint8Array;
    messages: Uint8Array[];
  }): Promise<Uint8Array>;
  export function verifySignature(args: {
    ciphersuite: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
    header: Uint8Array;
    messages: Uint8Array[];
  }): Promise<boolean>;
}

declare module 'jsonld';

