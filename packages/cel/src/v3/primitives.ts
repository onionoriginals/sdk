import { base58, base64urlnopad } from "@scure/base";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { p256, p384 } from "@noble/curves/nist.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { CelError, requireThat } from "./errors.js";
import { canonicalizeValue } from "./values.js";
import type { Algorithm } from "./types.js";

export const ALGORITHMS = Object.freeze({
  Ed25519: {
    codec: [0xed, 1],
    length: 32,
    signature: 64,
    suite: "eddsa-jcs-2022",
    hash: sha256,
  },
  "P-256": {
    codec: [0x80, 0x24],
    length: 33,
    signature: 64,
    suite: "ecdsa-jcs-2019",
    hash: sha256,
  },
  "P-384": {
    codec: [0x81, 0x24],
    length: 49,
    signature: 96,
    suite: "ecdsa-jcs-2019",
    hash: sha384,
  },
} as const);
export function decodeBase58(value: string): Uint8Array {
  requireThat(
    /^z[1-9A-HJ-NP-Za-km-z]+$/.test(value),
    "CEL_BASE58",
    "Expected base58btc multibase",
  );
  const bytes = base58.decode(value.slice(1));
  requireThat(
    "z" + base58.encode(bytes) === value,
    "CEL_BASE58",
    "Noncanonical base58btc",
  );
  return bytes;
}
export function decodeBase64(value: string, length: number): Uint8Array {
  requireThat(
    /^[A-Za-z0-9_-]+$/.test(value),
    "CEL_BASE64",
    "Expected unpadded base64url",
  );
  let bytes: Uint8Array;
  try {
    bytes = base64urlnopad.decode(value);
  } catch {
    throw new CelError("invalid", "CEL_BASE64", "Noncanonical base64url");
  }
  requireThat(
    bytes.length === length && base64urlnopad.encode(bytes) === value,
    "CEL_BASE64",
    "Noncanonical base64url or wrong length",
  );
  return bytes;
}
/** Validate the profile's exact SHA-256 multihash representation. */
export function validateDigest(value: unknown): asserts value is string {
  requireThat(
    typeof value === "string" && value.startsWith("u"),
    "CEL_DIGEST",
    "Expected base64url multibase digest",
  );
  const bytes = decodeBase64(value.slice(1), 34);
  requireThat(
    bytes[0] === 0x12 && bytes[1] === 0x20,
    "CEL_DIGEST",
    "Expected SHA-256 multihash",
  );
}
/** Hash exact resource bytes, without text conversion. */
export function digestBytes(bytes: Uint8Array): string {
  requireThat(bytes instanceof Uint8Array, "CEL_BYTES", "Expected bytes");
  return (
    "u" + base64urlnopad.encode(Uint8Array.from([0x12, 0x20, ...sha256(bytes)]))
  );
}
export function hashJson(value: unknown): string {
  return digestBytes(new TextEncoder().encode(canonicalizeValue(value)));
}

/** Resolve a canonical did:key locally, including curve-point validity. No remote resolver. */
export function decodeController(controller: unknown): {
  algorithm: Algorithm;
  publicKey: Uint8Array;
  verificationMethod: string;
} {
  requireThat(
    typeof controller === "string" &&
      controller.length <= 256 &&
      /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(controller),
    "CEL_CONTROLLER",
    "Expected canonical did:key controller",
  );
  const fingerprint = controller.slice(8),
    encoded = decodeBase58(fingerprint);
  const algorithm = (Object.keys(ALGORITHMS) as Algorithm[]).find((name) => {
    const spec = ALGORITHMS[name];
    return (
      encoded.length === spec.length + 2 &&
      spec.codec.every((b, i) => encoded[i] === b)
    );
  });
  requireThat(
    algorithm,
    "CEL_CONTROLLER",
    "Unsupported or noncanonical public-key codec",
  );
  const publicKey = encoded.slice(2);
  try {
    if (algorithm === "Ed25519") {
      const point = ed25519.Point.fromBytes(publicKey, false);
      point.assertValidity();
      requireThat(
        !point.isSmallOrder() && point.isTorsionFree(),
        "CEL_CONTROLLER",
        "Invalid Ed25519 public key",
      );
      requireThat(
        base58.encode(point.toBytes()) === base58.encode(publicKey),
        "CEL_CONTROLLER",
        "Noncanonical Ed25519 public key",
      );
    } else {
      requireThat(
        publicKey[0] === 2 || publicKey[0] === 3,
        "CEL_CONTROLLER",
        "Expected compressed public key",
      );
      (algorithm === "P-256" ? p256 : p384).Point.fromBytes(
        publicKey,
      ).assertValidity();
    }
  } catch (error) {
    if (error instanceof CelError) throw error;
    throw new CelError("invalid", "CEL_CONTROLLER", "Invalid curve point");
  }
  return {
    algorithm,
    publicKey,
    verificationMethod: controller + "#" + fingerprint,
  };
}
