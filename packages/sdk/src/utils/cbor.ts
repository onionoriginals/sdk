import * as cbor from 'cbor-js';

export function encode(input: unknown): Uint8Array {
  const encoded: any = (cbor as any).encode(input);
  return new Uint8Array(encoded);
}

export function decode<T = unknown>(bytes: Uint8Array | ArrayBuffer | Buffer): T {
  const view = new Uint8Array(bytes as any);
  return (cbor as any).decode(view.buffer) as T;
}

