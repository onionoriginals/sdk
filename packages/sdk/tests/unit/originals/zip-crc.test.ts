/**
 * The slicing-by-8 CRC-32 used for evidence package entries (P14.10) gives
 * the same value as the bytewise table loop at every length and alignment,
 * so archives are byte-identical and every CRC check passes or fails as
 * before.
 */
import { describe, expect, test } from "bun:test";
import { crc32, readZip, writeZip } from "../../../src/originals/zip.js";

/** The bytewise reference: one table lookup per byte. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function reference(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("crc32", () => {
  test("the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test("equals the bytewise CRC at every length 0..300 and every alignment of a view", () => {
    const base = noise(400, 7);
    for (let n = 0; n <= 300; n++) expect(crc32(base.subarray(0, n))).toBe(reference(base.subarray(0, n)));
    for (let offset = 0; offset < 16; offset++) {
      const view = base.subarray(offset, offset + 257);
      expect(crc32(view)).toBe(reference(view));
    }
  });

  test("equals the bytewise CRC on large inputs, all-zero and all-0xff bytes", () => {
    for (const data of [noise(680_000, 3), noise(1_000_003, 4), new Uint8Array(70_001), new Uint8Array(70_001).fill(0xff)]) {
      expect(crc32(data)).toBe(reference(data));
    }
  });

  test("an archive is byte-identical and still refuses a corrupted entry", () => {
    const files = new Map([["a/one.bin", noise(100_001, 5)], ["b.txt", new TextEncoder().encode("two")]]);
    const zip = writeZip(files);
    expect(writeZip(files)).toEqual(zip);
    expect(readZip(zip)).toEqual(new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1))));
    const corrupted = zip.slice();
    corrupted[200] ^= 1; // inside a/one.bin's data
    expect(() => readZip(corrupted)).toThrow(/CRC/);
  });
});
