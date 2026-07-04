import { encode as cborgEncode, decode as cborgDecode } from 'cborg';

/**
 * CBOR encode/decode built on `cborg`.
 *
 * The previously bundled `cbor-js@0.1.0` encoder silently corrupted any string
 * containing BMP code points in U+E000–U+FFFF (fullwidth forms, CJK
 * compatibility ideographs, private-use area, ...) by misclassifying them as
 * UTF-16 high surrogates. `cborg` encodes UTF-8 correctly and rejects
 * malformed input.
 *
 * Decoding goes through `useMaps` and an explicit Map→object conversion so a
 * `__proto__` map key becomes an ordinary own property instead of reassigning
 * the decoded object's prototype (prototype pollution).
 */
export function encode(input: unknown): Uint8Array {
  return cborgEncode(input);
}

function mapsToObjects(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      if (typeof k !== 'string') {
        throw new Error('CBOR decode error: non-string map keys are not supported');
      }
      // Only '__proto__' needs the defineProperty path — plain assignment
      // would invoke the prototype setter (the pollution vector this module
      // exists to close). Everything else takes the fast path.
      if (k === '__proto__') {
        Object.defineProperty(obj, k, {
          value: mapsToObjects(v),
          writable: true,
          enumerable: true,
          configurable: true
        });
      } else {
        obj[k] = mapsToObjects(v);
      }
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(mapsToObjects);
  }
  return value;
}

export function decode<T = unknown>(bytes: Uint8Array | ArrayBuffer | Buffer): T {
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else {
    // Uint8Array and Buffer both expose buffer/byteOffset/byteLength
    u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const decoded = cborgDecode(u8, {
    useMaps: true,
    allowIndefinite: true,
    allowUndefined: true,
    allowNaN: true,
    allowInfinity: true,
    allowBigInt: true
  });
  return mapsToObjects(decoded) as T;
}
