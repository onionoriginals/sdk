/**
 * Bounded request bodies. A declared Content-Length over the cap is refused
 * before reading; a chunked body (or one whose declared length lies) is read
 * with a byte counter and abandoned as soon as it passes the cap, so no route
 * buffers more than `maxBytes` (+ one chunk) of an oversized upload. The cap
 * counts bytes, never characters.
 */

/** The body's bytes, or null when it is larger than `maxBytes`. */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
