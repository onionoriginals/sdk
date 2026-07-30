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
 * Compressed input is fed in slices this size so the output budget can be
 * re-checked between pushes. fflate inflates an entire `push()` before
 * returning, so pushing the whole payload at once would spend the full CPU cost
 * of a bomb before the budget could stop it — the point is to bound work, not
 * just memory. Measured on a 400 MB bomb: ~920ms in one push vs ~12ms sliced.
 */
export const INPUT_SLICE_BYTES = 4096;

/**
 * Decompress with a hard output budget, bounding both memory and CPU.
 *
 * fflate has no `maxOutputLength` equivalent: passing a pre-sized `out` buffer
 * makes it **silently truncate** rather than throw, which for a status list
 * would read as "not revoked" for entries past the cut — fail-open. So stream
 * instead: stop retaining chunks the moment the budget is passed (bounding
 * memory), and stop feeding input (bounding the remaining inflate work).
 */
function boundedDecompress(data: Uint8Array, maxBytes: number, Ctor: StreamCtor): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;

  const stream = new Ctor((chunk) => {
    if (overflowed) return;
    total += chunk.length;
    if (total > maxBytes) {
      // Drop this chunk and every later one: memory stays bounded even if the
      // remainder of the current slice still inflates.
      overflowed = true;
      return;
    }
    chunks.push(chunk);
  });

  if (data.length === 0) {
    stream.push(data, true);
  } else {
    for (let offset = 0; offset < data.length; offset += INPUT_SLICE_BYTES) {
      const end = Math.min(offset + INPUT_SLICE_BYTES, data.length);
      stream.push(data.subarray(offset, end), end === data.length);
      if (overflowed) break;
    }
  }

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
