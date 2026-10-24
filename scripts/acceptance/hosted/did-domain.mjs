/**
 * The acceptance account's identity DID must be on the instance's own
 * did:webvh domain (#976 B1, B2; hosted-README.md "Account"). An account that
 * signed in before G1 keeps a magby identity that doesn't resolve from
 * staging, so its author binding fails.
 */
/** The domain a did:webvh names (`did:webvh:<SCID>:<domain>:…`), with a percent-encoded port decoded. */
export function didWebvhDomain(did) {
  const parts = did.split(":");
  return parts[0] === "did" && parts[1] === "webvh" && parts.length >= 4 ? decodeURIComponent(parts[3]) : null;
}
