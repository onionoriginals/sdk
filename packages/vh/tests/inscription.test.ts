/**
 * Reading an Originals inscription's metadata (P14.12; originals-spec #53):
 * the CBOR of a JSON array of entries, strict, split over data pushes that a
 * reader concatenates before decoding.
 */
import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../src/json/index.js";
import { createOriginal, decodeCbor, encodeCbor, readInscribedEntries } from "../src/originals/index.js";
import { VhAuthor, photo, seeded } from "./helpers/originals.js";

async function entry() {
  const key = seeded(31);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  return createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", metadata: { caption: "x".repeat(600) }, resource: photo("harbor"), author: alice.ref("orig"), sign: alice.signer(key, "orig") });
}

describe("inscription metadata (P14.12)", () => {
  test("an array of entries decodes to them; anything else is not an Originals inscription", async () => {
    const e = await entry();
    expect(readInscribedEntries(encodeCbor([e] as unknown as JsonValue))).toEqual({ kind: "entries", entries: [e] });
    for (const m of [null, undefined, new Uint8Array(), encodeCbor({ id: "did:btco:reg:1" }), encodeCbor("text"), encodeCbor(1)]) {
      expect(readInscribedEntries(m).kind).toBe("not-originals");
    }
    for (const m of [encodeCbor([]), encodeCbor([1]), encodeCbor([[]])]) expect(readInscribedEntries(m).kind).toBe("invalid");
  });

  test("C12-195: a tag, byte string, indefinite-length item, non-text or duplicate key, or an integer beyond 2^53 - 1 makes it invalid", () => {
    // Each item is the value of `x` in one entry-shaped map, so only the item can make it invalid.
    const within = (item: number[]) => new Uint8Array([0x81, 0xa1, 0x61, 0x78, ...item]);
    expect(readInscribedEntries(within([0x01])).kind).toBe("entries");
    const bad = [
      [0xc0, 0x01], [0x41, 0x00], [0x9f, 0x01, 0xff], [0x7f, 0x61, 0x61, 0xff],
      [0xa1, 0x01, 0x02], [0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02],
      [0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], [0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    ];
    for (const item of bad) expect(readInscribedEntries(within(item)).kind, item.join(",")).toBe("invalid");
    // The bound is exact: 2^53 - 1 and -(2^53 - 1) are integers JSON can carry (P14.3).
    expect(readInscribedEntries(within([0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).kind).toBe("entries");
    expect(readInscribedEntries(within([0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe])).kind).toBe("entries");
    // Trailing bytes after the one item.
    expect(readInscribedEntries(new Uint8Array([...within([0x01]), 0x00])).kind).toBe("invalid");
  });

  // originals-spec #54: a non-integer number is a float of any of the three widths, checked over JCS.
  test("C12-198: a half-, single- or double-precision float decodes to its number, and the encoder writes the narrowest exact width", () => {
    const within = (item: number[]) => new Uint8Array([0x81, 0xa1, 0x61, 0x78, ...item]);
    const value = (item: number[]) => {
      const r = readInscribedEntries(within(item));
      return r.kind === "entries" ? (r.entries[0] as unknown as { x: number }).x : r.kind;
    };
    // 4.5 at each width, and an integral 1.0 as a half float, which JCS writes as 1.
    expect(value([0xf9, 0x44, 0x80])).toBe(4.5);
    expect(value([0xfa, 0x40, 0x90, 0x00, 0x00])).toBe(4.5);
    expect(value([0xfb, 0x40, 0x12, 0, 0, 0, 0, 0, 0])).toBe(4.5);
    expect(value([0xf9, 0x3c, 0x00])).toBe(1);
    expect(value([0xf9, 0x00, 0x01])).toBe(2 ** -24); // the smallest subnormal half
    expect(value([0xfb, 0x43, 0x3f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).toBe(2 ** 53 - 1);
    // ord's mapping (ciborium): the narrowest width that holds the number exactly.
    expect([...encodeCbor(4.5)]).toEqual([0xf9, 0x44, 0x80]);
    expect([...encodeCbor(-0.5)]).toEqual([0xf9, 0xb8, 0x00]);
    expect([...encodeCbor(65504.5)]).toEqual([0xfa, 0x47, 0x7f, 0xe0, 0x80]);
    expect([...encodeCbor(0.1)]).toEqual([0xfb, 0x3f, 0xb9, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a]);
    expect([...encodeCbor(3)]).toEqual([0x03]); // an integer stays an integer
    for (const n of [4.5, -0.5, 65504.5, 0.1, 1.5e-6, 2 ** -24, 1e-300, 123456.789]) expect(decodeCbor(encodeCbor(n), { shortest: false })).toBe(n);
  });

  test("C12-199: a NaN, infinite or negative-zero float, or one above 2^53 - 1, makes it invalid", () => {
    const within = (item: number[]) => new Uint8Array([0x81, 0xa1, 0x61, 0x78, ...item]);
    for (const item of [
      [0xf9, 0x7e, 0x00], [0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0], // NaN
      [0xf9, 0x7c, 0x00], [0xf9, 0xfc, 0x00], [0xfa, 0x7f, 0x80, 0, 0], // ±Infinity
      [0xf9, 0x80, 0x00], [0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0], // −0
      [0xfa, 0x5a, 0x00, 0x00, 0x00], [0xfb, 0x7e, 0x37, 0xe4, 0x3c, 0x88, 0x00, 0x75, 0x9c], [0xfb, 0xc3, 0x40, 0, 0, 0, 0, 0, 0], // 2^53, 1e300, −2^53
    ]) expect(readInscribedEntries(within(item)).kind, item.join(",")).toBe("invalid");
    for (const n of [Number.NaN, Infinity, -0, 2 ** 53]) expect(() => encodeCbor(n), String(n)).toThrow();
  });

  test("integers need not be in shortest form for entries; a did:btco DID document's must be", () => {
    const loose = new Uint8Array([0x81, 0xa1, 0x61, 0x78, 0x18, 0x01]); // 1 written in two bytes
    expect(readInscribedEntries(loose)).toEqual({ kind: "entries", entries: [{ x: 1 }] as never });
    expect(() => decodeCbor(loose)).toThrow();
  });

  test("C12-196: metadata split over 520-byte data pushes decodes once concatenated, and not from one push alone", async () => {
    const e = await entry();
    const meta = encodeCbor([e] as unknown as JsonValue);
    expect(meta.length).toBeGreaterThan(520);
    const pushes: Uint8Array[] = [];
    for (let at = 0; at < meta.length; at += 520) pushes.push(meta.slice(at, at + 520));
    expect(pushes.length).toBeGreaterThan(1);
    const joined = new Uint8Array(pushes.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pushes) {
      joined.set(p, at);
      at += p.length;
    }
    expect(readInscribedEntries(joined)).toEqual({ kind: "entries", entries: [e] });
    expect(readInscribedEntries(pushes[0]).kind).toBe("invalid");
  });
});
