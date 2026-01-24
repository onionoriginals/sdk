import * as cbor from 'cbor-js';

interface CborModule {
  encode: (input: unknown) => ArrayBuffer;
  decode: (buffer: ArrayBuffer) => unknown;
}

export function encode(input: unknown): Uint8Array {
  const cborTyped = cbor as unknown as CborModule;
  const encoded = cborTyped.encode(input);
  return new Uint8Array(encoded);
}

export function decode<T = unknown>(bytes: Uint8Array | ArrayBuffer | Buffer): T {
  const cborTyped = cbor as unknown as CborModule;
  let arrayBuffer: ArrayBuffer;
  if (bytes instanceof ArrayBuffer) {
    arrayBuffer = bytes;
  } else if (bytes instanceof Uint8Array) {
    arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } else {
    // Buffer - explicitly handle Buffer type
    const bufferInstance = bytes as Buffer;
    arrayBuffer = bufferInstance.buffer.slice(
      bufferInstance.byteOffset,
      bufferInstance.byteOffset + bufferInstance.byteLength
    ) as ArrayBuffer;
  }
  return cborTyped.decode(arrayBuffer) as T;
}

