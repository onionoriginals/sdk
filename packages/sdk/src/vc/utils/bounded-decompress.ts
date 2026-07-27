import { gzipSync as fflateGzipSync, Gunzip, Unzlib } from 'fflate';

/**
 * GZIP helpers backed by fflate rather than `node:zlib`, so status lists work in
 * browsers and edge runtimes. Signatures stay synchronous — a lazy
 * `await import('node:zlib')` would have forced every caller async.
 */

export function gzipBytes(data: Uint8Array): Uint8Array {
  return fflateGzipSync(data);
}

type StreamCtor = typeof Gunzip | typeof Unzlib;

/**
 * Decompress with a hard output budget.
 *
 * fflate has no `maxOutputLength` equivalent: passing a pre-sized `out` buffer
 * makes it **silently truncate** rather than throw, which for a status list
 * would read as "not revoked" for entries past the cut — fail-open. So stream
 * instead and abort as soon as the budget is passed.
 */
function boundedDecompress(data: Uint8Array, maxBytes: number, Ctor: StreamCtor): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;

  const stream = new Ctor((chunk) => {
    if (overflowed) return;
    total += chunk.length;
    if (total > maxBytes) {
      overflowed = true;
      return;
    }
    chunks.push(chunk);
  });

  stream.push(data, true);

  if (overflowed) {
    throw new Error(`decompressed output exceeded the ${maxBytes}-byte limit`);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** GZIP (RFC 1952), the W3C Bitstring Status List wire format. */
export function boundedGunzip(data: Uint8Array, maxBytes: number): Uint8Array {
  return boundedDecompress(data, maxBytes, Gunzip);
}

/**
 * ZLIB-wrapped DEFLATE (RFC 1950) — what `node:zlib`'s `inflateSync` accepted,
 * used by the legacy pre-spec encoding. fflate's `inflateSync` is *raw* deflate
 * and rejects this framing, so the equivalent is `Unzlib`.
 */
export function boundedUnzlib(data: Uint8Array, maxBytes: number): Uint8Array {
  return boundedDecompress(data, maxBytes, Unzlib);
}
