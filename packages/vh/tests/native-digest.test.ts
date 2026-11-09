/**
 * Native SHA-256 for resource digests (P4.3): `sha256Async` and
 * `resourceDigestAsync` use the platform's WebCrypto where it has one and
 * noble otherwise. A digest is SHA-256 either way, so every result is
 * byte-identical, and verification reports are the same with native hashing
 * on or off: the same `verified`, `missing` and `mismatch` per version, the
 * same reasons (C12-02, C12-10).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NATIVE_SHA256_MIN_BYTES, sha256, sha256Async, sha256Multihash, sha256MultihashAsync } from "../src/crypto/index.js";
import { createOriginal, resourceDigest, resourceDigestAsync, updateOriginal, verifyOriginal, type ResourceDescriptor } from "../src/originals/index.js";
import { NOW, VhAuthor, clock, seeded } from "./helpers/originals.js";

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
afterEach(() => Object.defineProperty(globalThis, "crypto", realCrypto));

/** Run with WebCrypto replaced (undefined: no WebCrypto at all). */
function withCrypto(value: unknown) {
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
}

function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const SIZES = [0, 1, 55, 56, 64, NATIVE_SHA256_MIN_BYTES - 1, NATIVE_SHA256_MIN_BYTES, NATIVE_SHA256_MIN_BYTES + 1, 680_000];

describe("sha256Async", () => {
  test("equals noble's SHA-256 at every size, on both sides of the native threshold", async () => {
    for (const n of SIZES) {
      const data = noise(n, n + 7);
      expect(await sha256Async(data)).toEqual(sha256(data));
      expect(await sha256MultihashAsync(data)).toEqual(sha256Multihash(data));
      expect(await resourceDigestAsync(data)).toBe(resourceDigest(data));
    }
  });

  test("hashes a subarray view exactly, not its whole buffer", async () => {
    const whole = noise(NATIVE_SHA256_MIN_BYTES * 3, 3);
    const view = whole.subarray(100, 100 + NATIVE_SHA256_MIN_BYTES * 2);
    expect(await sha256Async(view)).toEqual(sha256(view.slice()));
  });

  test("uses WebCrypto for a large input and noble for a small one", async () => {
    let calls = 0;
    const subtle = realCrypto.value.subtle;
    withCrypto({ subtle: { digest: (a: string, d: Uint8Array) => (calls++, subtle.digest(a, d)) } });
    const big = noise(NATIVE_SHA256_MIN_BYTES, 9);
    expect(await sha256Async(big)).toEqual(sha256(big));
    expect(calls).toBe(1);
    await sha256Async(noise(64));
    expect(calls).toBe(1);
  });

  test("falls back to noble without WebCrypto", async () => {
    withCrypto(undefined);
    const data = noise(680_000, 4);
    expect(await sha256Async(data)).toEqual(sha256(data));
    withCrypto({});
    expect(await sha256Async(data)).toEqual(sha256(data));
  });

  test("falls back to noble when WebCrypto refuses the input", async () => {
    withCrypto({ subtle: { digest: () => Promise.reject(new TypeError("SharedArrayBuffer views are not accepted")) } });
    const data = noise(680_000, 5);
    expect(await sha256Async(data)).toEqual(sha256(data));
  });
});

describe("verifyOriginal reports the same with native hashing on or off", () => {
  test("verified, missing and mismatched versions over the threshold (C12-02, C12-10)", async () => {
    const key = seeded(31);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const author = alice.ref("orig");
    const sign = alice.signer(key, "orig");
    const v1 = noise(NATIVE_SHA256_MIN_BYTES * 4, 11);
    const v2 = noise(NATIVE_SHA256_MIN_BYTES * 4, 12);
    const v3 = noise(NATIVE_SHA256_MIN_BYTES * 4 + 3, 13);
    const describe = (b: Uint8Array): ResourceDescriptor => ({ mediaType: "image/png", size: b.length, digest: resourceDigest(b) });
    const genesis = await createOriginal({ versionTime: at(), name: "big", resource: describe(v1), author, sign });
    const second = await updateOriginal(genesis, { versionTime: at(), resource: describe(v2), author, sign });
    const third = await updateOriginal(second, { versionTime: at(), resource: describe(v3), author, sign });
    // v1 verifies, v2 is a same-size substitute (mismatch), v3 is missing.
    const substitute = noise(v2.length, 99);
    const options = { log: [genesis, second, third], authors: [alice.evidence()], now: NOW, bytes: { [describe(v1).digest]: v1, [describe(v2).digest]: substitute } };

    const native = await verifyOriginal(options);
    withCrypto(undefined);
    const noble = await verifyOriginal(options);

    expect(native).toEqual(noble);
    expect(native.resources.versions.map((v) => v.bytes)).toEqual(["verified", "mismatch", "missing"]);
    expect(native.resources.status).toBe("digest-failure");
    expect(native.reasons).toContain("resources-digest-failure");
  });
});

describe("verifyOriginal with bytes checked when stored (`checked`)", () => {
  test("C12-02, C12-10: the same report as supplying the bytes; supplied bytes take precedence and are hashed", async () => {
    const key = seeded(32);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const author = alice.ref("orig");
    const sign = alice.signer(key, "orig");
    const v1 = noise(40_000, 21), v2 = noise(40_000, 22);
    const d = (b: Uint8Array): ResourceDescriptor => ({ mediaType: "image/png", size: b.length, digest: resourceDigest(b) });
    const genesis = await createOriginal({ versionTime: at(), name: "held", resource: d(v1), author, sign });
    const second = await updateOriginal(genesis, { versionTime: at(), resource: d(v2), author, sign });
    const base = { log: [genesis, second], authors: [alice.evidence()], now: NOW };
    const sizes = new Map([[d(v1).digest, v1.length], [d(v2).digest, v2.length]]);

    const supplied = await verifyOriginal({ ...base, bytes: { [d(v1).digest]: v1, [d(v2).digest]: v2 } });
    const held = await verifyOriginal({ ...base, checked: (digest) => sizes.get(digest) });
    expect(held).toEqual(supplied);
    expect(held.resources.versions.map((v) => v.bytes)).toEqual(["verified", "verified"]);

    // Held at another size than the descriptor's: a mismatch, as supplied bytes of that size would be.
    const wrongSize = await verifyOriginal({ ...base, checked: (digest) => (digest === d(v1).digest ? v1.length + 1 : undefined) });
    expect(wrongSize.resources.versions.map((v) => v.bytes)).toEqual(["mismatch", "missing"]);
    expect(wrongSize.reasons).toContain("resources-digest-failure");

    // Supplied bytes are used, and hashed, even when `checked` vouches for the digest.
    const swapped = await verifyOriginal({ ...base, bytes: { [d(v1).digest]: noise(40_000, 99) }, checked: (digest) => sizes.get(digest) });
    expect(swapped.resources.versions.map((v) => v.bytes)).toEqual(["mismatch", "verified"]);
  });
});
