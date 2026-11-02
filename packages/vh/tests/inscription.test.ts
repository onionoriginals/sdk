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

  test("C12-195: a tag, byte string, float, indefinite-length item, non-text or duplicate key, or an integer beyond 2^53 - 1 makes it invalid", () => {
    // Each item is the value of `x` in one entry-shaped map, so only the item can make it invalid.
    const within = (item: number[]) => new Uint8Array([0x81, 0xa1, 0x61, 0x78, ...item]);
    expect(readInscribedEntries(within([0x01])).kind).toBe("entries");
    const bad = [
      [0xc0, 0x01], [0x41, 0x00], [0xf9, 0x3c, 0x00], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0x9f, 0x01, 0xff], [0x7f, 0x61, 0x61, 0xff],
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
