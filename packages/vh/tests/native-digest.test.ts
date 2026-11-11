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

describe("supplied bytes are not copied before their size is checked", () => {
  test("an input larger than its descriptor is a mismatch, reported without copying it (C12-10)", async () => {
    const key = seeded(43);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const small = new Uint8Array(32 * 1024).fill(1);
    const d = { mediaType: "application/octet-stream", size: small.length, digest: resourceDigest(small) };
    const genesis = await createOriginal({ versionTime: at(), name: "sized", resource: d, author: alice.ref("orig"), sign: alice.signer(key, "orig") });
    const huge = new Uint8Array(4 * 1024 * 1024).fill(1);
    let copies = 0;
    const RealUint8Array = globalThis.Uint8Array;
    // Count array allocations of the huge size while verifying: the oversized input must not be copied.
    const counting = new Proxy(RealUint8Array, {
      construct(target, args: unknown[]) {
        const made = Reflect.construct(target, args) as Uint8Array;
        if (made.length === huge.length && !(args[0] instanceof ArrayBuffer)) copies++;
        return made;
      },
    });
    globalThis.Uint8Array = counting as unknown as Uint8ArrayConstructor;
    let report;
    try {
      report = await verifyOriginal({ log: [genesis], authors: [alice.evidence()], now: NOW, bytes: { [d.digest]: huge } });
    } finally {
      globalThis.Uint8Array = RealUint8Array;
    }
    expect(report.resources.versions.map((v) => v.bytes)).toEqual(["mismatch"]);
    expect(copies).toBe(0);
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

describe("verification options are read when they were before native hashing", () => {
  async function oneVersion() {
    const key = seeded(31);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const v1 = noise(NATIVE_SHA256_MIN_BYTES * 2, 24);
    const descriptor: ResourceDescriptor = { mediaType: "image/png", size: v1.length, digest: resourceDigest(v1) };
    const first = await createOriginal({ versionTime: clock()(), name: "test", resource: descriptor, author: alice.ref("orig"), sign: alice.signer(key, "orig") });
    return { alice, v1, first };
  }

  test("a retained version a bytes callback sets after it returns is not the one reported (C12-10)", async () => {
    const { alice, v1, first } = await oneVersion();
    for (const crypto of [realCrypto.value, undefined]) {
      withCrypto(crypto);
      const retained: { original?: string } = {};
      const report = await verifyOriginal({
        log: [first], authors: [alice.evidence()], now: NOW, retained,
        bytes: () => (queueMicrotask(() => (retained.original = first.versionId)), v1),
      });
      // Read with the bytes, as when they were hashed synchronously: nothing was retained then.
      expect(report.assetFreshness.retainedVersionId).toBeNull();
      expect(report.resources.status).toBe("available");
    }
  });

  test("identity evidence a bytes callback changes after it returns is reported as it was (C12-10)", async () => {
    const { alice, v1, first } = await oneVersion();
    for (const crypto of [realCrypto.value, undefined]) {
      withCrypto(crypto);
      const evidence = alice.evidence();
      const before = evidence.obtainedAt ?? null;
      const report = await verifyOriginal({
        log: [first], authors: [evidence], now: NOW,
        bytes: () => (queueMicrotask(() => (evidence.obtainedAt = "2001-01-01T00:00:00Z")), v1),
      });
      expect(report.identityEvidence.obtained.obtainedAt).toBe(before);
    }
  });
});

describe("native hashing holds a bounded amount of copied bytes", () => {
  test("past the budget, versions are hashed with noble and report the same (C12-02)", async () => {
    const key = seeded(31);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const author = alice.ref("orig");
    const sign = alice.signer(key, "orig");
    // Nine 8 MiB versions, alternating two buffers: 72 MiB in all, over the 64 MiB budget.
    const size = 8 * 1024 * 1024;
    const pair = [new Uint8Array(size).fill(1), new Uint8Array(size).fill(2)];
    const descriptors = pair.map((b): ResourceDescriptor => ({ mediaType: "image/png", size, digest: resourceDigest(b) }));
    const log = [await createOriginal({ versionTime: at(), name: "big", resource: descriptors[0]!, author, sign })];
    for (let i = 1; i < 9; i++) log.push(await updateOriginal(log.at(-1)!, { versionTime: at(), resource: descriptors[i % 2]!, author, sign }));
    const bytes = { [descriptors[0]!.digest]: pair[0]!, [descriptors[1]!.digest]: pair[1]! };

    let inFlight = 0;
    let peak = 0;
    const subtle = realCrypto.value.subtle;
    withCrypto({
      subtle: {
        digest: (a: string, d: Uint8Array) => {
          inFlight += d.length;
          peak = Math.max(peak, inFlight);
          return subtle.digest(a, d).finally(() => (inFlight -= d.length));
        },
      },
    });
    const native = await verifyOriginal({ log, authors: [alice.evidence()], now: NOW, bytes });
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(64 * 1024 * 1024);
    withCrypto(undefined);
    const noble = await verifyOriginal({ log, authors: [alice.evidence()], now: NOW, bytes });
    expect(native).toEqual(noble);
    expect(native.resources.versions.map((v) => v.bytes)).toEqual(Array(9).fill("verified"));
  });
});
