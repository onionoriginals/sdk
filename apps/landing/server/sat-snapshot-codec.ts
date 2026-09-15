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
import type { SatSnapshot } from '@originals/sdk/cel';

export function encodeSatSnapshot(snapshot: SatSnapshot): unknown {
  return {
    ...snapshot,
    publications: snapshot.publications.map((publication) => ({
      ...publication,
      body:
        publication.body.status === 'complete'
          ? {
              ...publication.body,
              bytes: base64.encode(publication.body.bytes),
              metadata:
                publication.body.metadata === null
                  ? null
                  : base64.encode(publication.body.metadata),
            }
          : publication.body,
    })),
  };
}

/**
 * The total raw (pre-encoding) content bytes a snapshot carries across every
 * publication's body and metadata — the figure to bound BEFORE encoding and
 * serializing a snapshot for an unauthenticated caller, so a permitted large
 * publication can never turn one public request into an oversized response
 * or a large intermediate allocation.
 */
export function snapshotContentBytes(snapshot: SatSnapshot): number {
  let total = 0;
  for (const publication of snapshot.publications) {
    if (publication.body.status !== 'complete') continue;
    total += publication.body.bytes.length;
    total += publication.body.metadata?.length ?? 0;
  }
  return total;
}
