declare module 'cbor-js' {
  export function encode(data: any): ArrayBuffer;
  export function decode(data: ArrayBufferLike): any;
} 