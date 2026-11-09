/**
 * The signature-check cache. A signature check is a pure function of its key
 * type, public key, signed bytes and signature, and the cache is keyed by all
 * of them, so a cached result is the one checking again gives. These tests
 * hold every published vector to the same outcome cold, warm, and warm after
 * near-identical inputs, and hold whole verification reports deep-equal with
 * the cache cleared or warm (P5.12; vh-log-interop-0 section 2).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { SIGNATURE_CACHE_ENTRIES, SIGNATURE_CACHE_MAX_DATA, checkSignature, clearSignatureCache, verifyEd25519, verifyProof, type DataIntegrityProof } from "../src/crypto/index.js";
import { heldIds } from "../src/crypto/signature-cache.js";
import type { JsonObject } from "../src/json/index.js";
import { createOriginal, resourceDigest, updateOriginal, verifyOriginal } from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, seeded } from "./helpers/originals.js";

const corpus = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/vh-interop/ed25519/${name}`, import.meta.url), "utf8")) as unknown;

const signatureCacheSize = () => heldIds().length;
const idOf = (key: Uint8Array, msg: Uint8Array, sig: Uint8Array) => `Ed25519:${hex.encode(key)}:${hex.encode(msg)}:${hex.encode(sig)}`;

interface Vector { key: Uint8Array; msg: Uint8Array; sig: Uint8Array; expected: boolean }

function ed25519Vectors(): Vector[] {
  const out: Vector[] = [];
  const cctv = corpus("cctv.json") as Array<{ key: string; sig: string; msg: string }>;
  for (const v of cctv) {
    const key = hex.decode(v.key), msg = new TextEncoder().encode(v.msg), sig = hex.decode(v.sig);
    out.push({ key, msg, sig, expected: verifyEd25519(key, msg, sig) });
  }
  const { testGroups } = corpus("wycheproof.json") as { testGroups: Array<{ publicKey: { pk: string }; tests: Array<{ msg: string; sig: string }> }> };
  for (const g of testGroups) {
    for (const t of g.tests) {
      const key = hex.decode(g.publicKey.pk), msg = hex.decode(t.msg), sig = t.sig.length % 2 === 0 ? hex.decode(t.sig) : new Uint8Array(0);
      out.push({ key, msg, sig, expected: verifyEd25519(key, msg, sig) });
    }
  }
  return out;
}

const bip340 = JSON.parse(readFileSync(new URL("./fixtures/bip340-jcs-2025.didbtcr2.json", import.meta.url), "utf8")) as {
  cases: Array<{ document: JsonObject; proof: DataIntegrityProof; publicKeyMultibase: string }>;
};

beforeEach(() => clearSignatureCache());

describe("checkSignature", () => {
  const vectors = ed25519Vectors();

  test("gives the uncached result for all 1,065 C2SP CCTV and Wycheproof vectors, cold and warm", () => {
    expect(vectors.length).toBe(914 + 151);
    const check = () => vectors.map((v) => checkSignature({ type: "Ed25519", publicKey: v.key }, v.msg, v.sig));
    const cold = check();
    const warm = check();
    expect(cold).toEqual(vectors.map((v) => v.expected));
    expect(warm).toEqual(cold);
  });

  test("a cached result never answers for a different key, message or signature", () => {
    const valid = vectors.find((v) => v.expected && v.msg.length > 0 && v.sig.length === 64)!;
    expect(checkSignature({ type: "Ed25519", publicKey: valid.key }, valid.msg, valid.sig)).toBe(true);
    const flip = (b: Uint8Array, i: number) => { const c = b.slice(); c[i] ^= 1; return c; };
    expect(checkSignature({ type: "Ed25519", publicKey: valid.key }, flip(valid.msg, 0), valid.sig)).toBe(false);
    expect(checkSignature({ type: "Ed25519", publicKey: valid.key }, valid.msg, flip(valid.sig, 63))).toBe(false);
    expect(checkSignature({ type: "Ed25519", publicKey: flip(valid.key, 0) }, valid.msg, valid.sig)).toBe(false);
    // The same bytes read as another key type are another check.
    expect(checkSignature({ type: "secp256k1", publicKey: new Uint8Array([2, ...valid.key]) }, valid.msg, valid.sig)).toBe(false);
    // And the valid one still verifies.
    expect(checkSignature({ type: "Ed25519", publicKey: valid.key }, valid.msg, valid.sig)).toBe(true);
  });

  test("bip340-jcs-2025 proofs verify and alterations fail, cold and warm", () => {
    const run = () => bip340.cases.flatMap((c, i) => {
      const other = bip340.cases[(i + 1) % bip340.cases.length];
      return [
        verifyProof(c.document, c.proof, c.publicKeyMultibase),
        verifyProof({ ...c.document, versionTime: "2026-10-18T12:00:01Z" }, c.proof, c.publicKeyMultibase),
        verifyProof(c.document, c.proof, other.publicKeyMultibase),
        verifyProof(c.document, { ...c.proof, proofValue: other.proof.proofValue }, c.publicKeyMultibase),
      ];
    });
    const cold = run();
    expect(cold).toEqual(bip340.cases.flatMap(() => [true, false, false, false]));
    expect(run()).toEqual(cold);
  });

  test("is bounded: the oldest result is dropped first, and a dropped one is checked again correctly", () => {
    const v = vectors.find((x) => x.expected && x.msg.length <= SIGNATURE_CACHE_MAX_DATA)!;
    const first = idOf(v.key, v.msg, v.sig);
    const filler = (i: number) => {
      const msg = new Uint8Array(8);
      new DataView(msg.buffer).setUint32(0, i);
      return msg;
    };
    expect(checkSignature({ type: "Ed25519", publicKey: v.key }, v.msg, v.sig)).toBe(true);
    expect(heldIds()).toEqual([first]);
    expect(checkSignature({ type: "Ed25519", publicKey: v.key }, v.msg, v.sig)).toBe(true);
    expect(heldIds()).toEqual([first]); // a hit adds nothing
    // Fill the cache to its bound with distinct checks that fail fast (a 63-byte signature).
    const short = v.sig.subarray(0, 63);
    for (let i = 0; i < SIGNATURE_CACHE_ENTRIES - 1; i++) {
      expect(checkSignature({ type: "Ed25519", publicKey: v.key }, filler(i), short)).toBe(false);
    }
    expect(signatureCacheSize()).toBe(SIGNATURE_CACHE_ENTRIES);
    expect(heldIds()[0]).toBe(first);
    // One more: the oldest, `first`, is the one dropped; the newest stays.
    const newest = idOf(v.key, filler(SIGNATURE_CACHE_ENTRIES), short);
    expect(checkSignature({ type: "Ed25519", publicKey: v.key }, filler(SIGNATURE_CACHE_ENTRIES), short)).toBe(false);
    expect(signatureCacheSize()).toBe(SIGNATURE_CACHE_ENTRIES);
    expect(heldIds()).not.toContain(first);
    expect(heldIds()[0]).toBe(idOf(v.key, filler(0), short));
    expect(heldIds().at(-1)).toBe(newest);
    // Checking `first` again is a miss: it is computed again (still true), held as the newest, and drops the next oldest.
    expect(checkSignature({ type: "Ed25519", publicKey: v.key }, v.msg, v.sig)).toBe(true);
    expect(heldIds().at(-1)).toBe(first);
    expect(heldIds()).not.toContain(idOf(v.key, filler(0), short));
    clearSignatureCache();
    expect(signatureCacheSize()).toBe(0);
  });

  test("is bounded in bytes: checks over large messages are not kept, and give the same result", () => {
    const v = vectors.find((x) => x.expected)!;
    for (let i = 0; i < 32; i++) {
      const big = new Uint8Array(1 << 20).fill(i);
      expect(checkSignature({ type: "Ed25519", publicKey: v.key }, big, v.sig.subarray(0, 63))).toBe(false);
      expect(checkSignature({ type: "Ed25519", publicKey: v.key }, big, v.sig)).toBe(false);
    }
    expect(signatureCacheSize()).toBe(0);
    const long = vectors.find((x) => x.msg.length > SIGNATURE_CACHE_MAX_DATA);
    if (long) {
      expect(checkSignature({ type: "Ed25519", publicKey: long.key }, long.msg, long.sig)).toBe(long.expected);
      expect(signatureCacheSize()).toBe(0);
    }
  });
});

describe("verifyOriginal with the cache cleared or warm", () => {
  test("reports the same for a valid log and for one whose last proof was altered", async () => {
    const key = seeded(41);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const author = alice.ref("orig");
    const sign = alice.signer(key, "orig");
    const b1 = bytes("first"), b2 = bytes("second");
    const d = (b: Uint8Array) => ({ mediaType: "text/plain", size: b.length, digest: resourceDigest(b) });
    const genesis = await createOriginal({ versionTime: at(), name: "cached", resource: d(b1), author, sign });
    const second = await updateOriginal(genesis, { versionTime: at(), resource: d(b2), author, sign });
    const proof = second.proof![0] as DataIntegrityProof;
    const tampered = { ...second, proof: [{ ...proof, proofValue: genesis.proof![0].proofValue }] };
    const options = (log: typeof genesis[]) => ({ log, authors: [alice.evidence()], now: NOW, bytes: { [d(b1).digest]: b1, [d(b2).digest]: b2 } });

    for (const log of [[genesis, second], [genesis, tampered]]) {
      clearSignatureCache();
      const cold = await verifyOriginal(options(log));
      const warm = await verifyOriginal(options(log));
      expect(warm).toEqual(cold);
    }
    // Warmed by the valid log, the altered one still fails at its second entry, and vice versa.
    clearSignatureCache();
    await verifyOriginal(options([genesis, second]));
    const bad = await verifyOriginal(options([genesis, tampered]));
    expect(bad.history.status).not.toBe("valid");
    expect(bad.history.entries).toBe(1);
    const good = await verifyOriginal(options([genesis, second]));
    expect(good.history.status).toBe("valid");
    expect(good.history.entries).toBe(2);
  });
});
