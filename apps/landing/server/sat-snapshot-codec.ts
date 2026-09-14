/**
 * JSON-safe encoding for a `SatSnapshot` over an HTTP response. `bytes` and
 * `metadata` are `Uint8Array`s that `JSON.stringify` cannot represent, so they
 * are carried as plain number arrays (`decodeSatSnapshot` on the client side
 * reverses this). Shared by every Bitcoin sat-snapshot route — the
 * authenticated money-path proxy and the public read-only Explore
 * verification path — so the wire shape cannot drift between them.
 */
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
              bytes: Array.from(publication.body.bytes),
              metadata:
                publication.body.metadata === null
                  ? null
                  : Array.from(publication.body.metadata),
            }
          : publication.body,
    })),
  };
}
