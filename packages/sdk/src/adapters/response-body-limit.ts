/**
 * Shared streaming byte cap for provider HTTP responses (issue #606).
 *
 * A `Content-Length` precheck alone is a cheap fast-fail, not a bound: a
 * chunked/streamed response omits or can lie about that header, and reading
 * it via `Response.arrayBuffer()` first materializes the ENTIRE body before
 * its length is ever checked. An adversarial or misbehaving upstream can
 * therefore force an oversized allocation before any provider-side cap has
 * a chance to reject it. `readResponseBodyCapped` consumes the body
 * incrementally and cancels the underlying stream the instant more than
 * `maxBytes` have been observed, so the excess is never buffered.
 */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number, public readonly declaredBytes?: number) {
    super(
      declaredBytes !== undefined
        ? `response exceeds ${maxBytes} bytes (Content-Length ${declaredBytes})`
        : `response body exceeds ${maxBytes} bytes`
    );
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Read `res`'s body while enforcing a hard byte cap, without ever buffering
 * more than `maxBytes` (+ the final over-cap chunk, which is discarded
 * rather than concatenated). Checks `Content-Length` first as a cheap
 * early reject, then streams via `res.body`'s reader when the runtime
 * exposes one; falls back to `arrayBuffer()` only for response-like objects
 * (e.g. test doubles) that don't implement a streaming body.
 */
export async function readResponseBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ResponseTooLargeError(maxBytes, declared);
    }
  }
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling immediately — the point of streaming is to never hold
        // more than the cap in memory, so the over-cap chunk is discarded
        // and the connection is torn down rather than read to completion.
        await reader.cancel(new ResponseTooLargeError(maxBytes)).catch(() => {});
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
