import { base64urlnopad } from "@scure/base";
import { decodeBase64, validateDigest } from "./primitives.js";
import { requireThat } from "./errors.js";

const NI_PREFIX = "ni:///sha-256;";
const CEL_PREFIX = "did:cel:";

/** Public Originals history identifier wrapping its genesis commitment multihash. */
export function assetIdFromDigest(digest: unknown): string {
  validateDigest(digest);
  return CEL_PREFIX + digest;
}

/** Recover the genesis commitment multihash (SCID for new histories). The former ni spelling remains readable. */
export function assetDigest(identity: unknown): string {
  requireThat(
    typeof identity === "string",
    "CEL_IDENTITY",
    "Expected an asset identity",
  );
  if (identity.startsWith(CEL_PREFIX)) {
    const digest = identity.slice(CEL_PREFIX.length);
    validateDigest(digest);
    return digest;
  }
  requireThat(
    identity.startsWith(NI_PREFIX),
    "CEL_IDENTITY",
    "Expected a did:cel or canonical ni asset identity",
  );
  const hash = decodeBase64(identity.slice(NI_PREFIX.length), 32);
  return "u" + base64urlnopad.encode(Uint8Array.from([0x12, 0x20, ...hash]));
}

/** Normalize Originals did:cel identifiers and their former ni spelling. */
export function normalizeAssetId(identity: unknown): string {
  return assetIdFromDigest(assetDigest(identity));
}

/** Compare identifiers without rewriting aliases retained in signed history. */
export function sameAssetIdentity(left: unknown, right: unknown): boolean {
  try {
    return normalizeAssetId(left) === normalizeAssetId(right);
  } catch {
    return false;
  }
}
