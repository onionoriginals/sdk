/**
 * JSON-safe encoding for a `SatSnapshot` over an HTTP response. `bytes` and
 * `metadata` are `Uint8Array`s that `JSON.stringify` cannot represent, so
 * they are carried as base64 strings (`decodeSatSnapshot` on the client
 * side reverses this) — not a decimal number array, which would roughly
 * quadruple a large inscription body's encoded size (each byte becoming
 * up to three digits plus a separator) instead of base64's ~1.37x.
 * Shared by every Bitcoin sat-snapshot route — the authenticated
 * money-path proxy and the public read-only Explore verification path —
 * so the wire shape cannot drift between them.
 */
import { base64 } from '@scure/base';
import type { SatSnapshot } from '@originals/sdk';

export function encodeSatSnapshot(snapshot: SatSnapshot): unknown {
  return {
    ...snapshot,
    publications: snapshot.publications.map((publication) => {
      const body = publication.body;
      // Any body can carry its own metadata: a complete one, a delegated or encoded one, and one not
      // requested because its metadata shows it is no Originals inscription (P14.12). Every one is
      // encoded, so the reader sees bytes, never a JSON object of indices (P9.12).
      const metadata = 'metadata' in body && body.metadata instanceof Uint8Array ? { metadata: base64.encode(body.metadata) } : {};
      return {
        ...publication,
        body: body.status === 'complete' ? { ...body, bytes: base64.encode(body.bytes), ...metadata } : { ...body, ...metadata },
      };
    }),
  };
}

/**
 * The total raw (pre-encoding) content bytes a snapshot carries across every
 * publication's body and metadata — the figure to bound BEFORE encoding and
 * serializing a snapshot for an unauthenticated caller, so a permitted large
 * publication can never turn one public request into an oversized response
 * or a large intermediate allocation. Metadata kept on an unread body counts too.
 */
export function snapshotContentBytes(snapshot: SatSnapshot): number {
  let total = 0;
  for (const publication of snapshot.publications) {
    const body = publication.body;
    if (body.status === 'complete') total += body.bytes.length;
    if ('metadata' in body && body.metadata instanceof Uint8Array) total += body.metadata.length;
  }
  return total;
}
