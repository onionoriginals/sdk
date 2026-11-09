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

describe("bytes are read when they were before native hashing", () => {
  test("a view WebCrypto refuses is hashed as it was at call time, the same with or without WebCrypto", async () => {
    const original = noise(NATIVE_SHA256_MIN_BYTES * 2, 21);
    const expected = sha256(original);
    for (const crypto of [realCrypto.value, undefined]) {
      withCrypto(crypto);
      const shared = new Uint8Array(new SharedArrayBuffer(original.length));
      shared.set(original);
      const pending = sha256Async(shared);
      shared.fill(99);
      expect(await pending).toEqual(expected);
    }
  });

  test("a view WebCrypto rejects is hashed by noble from the bytes at call time", async () => {
    // A WebCrypto that refuses every input after yielding: noble hashes after an await.
    withCrypto({ subtle: { digest: () => Promise.resolve().then(() => Promise.reject(new TypeError("refused"))) } });
    const original = noise(NATIVE_SHA256_MIN_BYTES * 2, 22);
    const view = original.slice();
    const pending = sha256Async(view);
    view.fill(7);
    expect(await pending).toEqual(sha256(original));
  });

  test("a bytes callback whose data changes after it returns gets the report it got when each version was hashed in turn (C12-02, C12-10)", async () => {
    const key = seeded(31);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const author = alice.ref("orig");
    const sign = alice.signer(key, "orig");
    const v1 = new Uint8Array(NATIVE_SHA256_MIN_BYTES * 2).fill(1);
    const v2 = new Uint8Array(NATIVE_SHA256_MIN_BYTES * 2).fill(2);
    const describe = (b: Uint8Array): ResourceDescriptor => ({ mediaType: "image/png", size: b.length, digest: resourceDigest(b) });
    const first = await createOriginal({ versionTime: at(), name: "test", resource: describe(v1), author, sign });
    const second = await updateOriginal(first, { versionTime: at(), resource: describe(v2), author, sign });
    for (const crypto of [realCrypto.value, undefined]) {
      withCrypto(crypto);
      // Version 2's bytes become right only after version 1's are returned: read then, they are wrong.
      const secondBytes = new Uint8Array(v2.length).fill(99);
      const report = await verifyOriginal({
        log: [first, second], authors: [alice.evidence()], now: NOW,
        bytes: (d) => {
          if (d === describe(v1).digest) {
            queueMicrotask(() => secondBytes.set(v2));
            return v1;
          }
          return secondBytes;
        },
      });
      expect(report.resources.versions.map((v) => v.bytes)).toEqual(["verified", "mismatch"]);
      expect(report.resources.status).toBe("digest-failure");
      expect(report.reasons).toContain("resources-digest-failure");
    }
  });

  test("bytes changed after the callback returns them do not verify in their place (C12-10)", async () => {
    const key = seeded(31);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const v1 = noise(NATIVE_SHA256_MIN_BYTES * 2, 23);
    const descriptor: ResourceDescriptor = { mediaType: "image/png", size: v1.length, digest: resourceDigest(v1) };
    const first = await createOriginal({ versionTime: clock()(), name: "test", resource: descriptor, author: alice.ref("orig"), sign: alice.signer(key, "orig") });
    // Wrong bytes when returned, right ones a microtask later.
    const view = new Uint8Array(v1.length).fill(99);
    const report = await verifyOriginal({ log: [first], authors: [alice.evidence()], now: NOW, bytes: () => (queueMicrotask(() => view.set(v1)), view) });
    expect(report.resources.versions[0]!.bytes).toBe("mismatch");
    expect(report.reasons).toContain("resources-digest-failure");
  });
});
