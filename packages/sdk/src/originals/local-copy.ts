/**
 * Internal, not exported from the package: the writer's local copy (P9.18).
 *
 * A writer checks its committed, unpublished log as a local copy, verified
 * whole and reported unverified on Bitcoin, never current, and only for its
 * own check before inscribing. Any other copy of an anchored Original's log
 * read without the anchor, such as a package or a hosted snapshot, reports at
 * most the entries before the first anchoring entry (P7.14). The Bitcoin
 * writer marks the package bytes it builds for its own check here, so that
 * `OriginalsSDK.load` verifies them whole; nothing a caller passes in is ever
 * marked.
 */
const localCopies = new WeakSet<Uint8Array>();

/** Mark `zip`, a package the writer built from its own store, as its local copy (P9.18). */
export function asLocalCopy(zip: Uint8Array): Uint8Array {
  localCopies.add(zip);
  return zip;
}

/** Whether `zip` is a package the writer marked as its own local copy (P9.18). */
export function isLocalCopy(zip: Uint8Array): boolean {
  return localCopies.has(zip);
}
