import { base64urlnopad } from "@scure/base";
import { decodeBase64, validateDigest } from "./primitives.js";
import { requireThat } from "./errors.js";

const NI_PREFIX = "ni:///sha-256;";
const LEGACY_PREFIX = "did:cel:";

/** RFC 6920 URI for the canonical genesis event's SHA-256, without a locator. */
export function assetIdFromDigest(digest: unknown): string {
  validateDigest(digest);
  return NI_PREFIX + base64urlnopad.encode(decodeBase64(digest.slice(1), 34).subarray(2));
}

/** Recover the unchanged event multihash. Legacy aliases are read compatibility only. */
export function assetDigest(identity: unknown): string {
  requireThat(typeof identity === "string", "CEL_IDENTITY", "Expected an asset identity");
  if (identity.startsWith(LEGACY_PREFIX)) {
    const digest = identity.slice(LEGACY_PREFIX.length);
    validateDigest(digest);
    return digest;
  }
  requireThat(identity.startsWith(NI_PREFIX), "CEL_IDENTITY", "Expected a canonical ni asset identity");
  const hash = decodeBase64(identity.slice(NI_PREFIX.length), 32);
  return "u" + base64urlnopad.encode(Uint8Array.from([0x12, 0x20, ...hash]));
}

/** Normalizes only this application's former alias, never a generic did:cel DID. */
export function normalizeAssetId(identity: unknown): string {
  return assetIdFromDigest(assetDigest(identity));
}

/** Public bindings may retain a signed 3.0 alias; both sides still commit to one exact genesis. */
export function sameAssetIdentity(left: unknown, right: unknown): boolean {
  try { return normalizeAssetId(left) === normalizeAssetId(right); }
  catch { return false; }
}
