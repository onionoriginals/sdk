import { describe, test, expect } from 'bun:test';
import { gzipSync as nodeGzip, gunzipSync as nodeGunzip, deflateSync as nodeDeflate } from 'node:zlib';
import {
  gzipBytes,
  boundedGunzip,
  boundedUnzlib,
  INPUT_SLICE_BYTES
} from '../../src/vc/utils/bounded-decompress';
import { BitstringStatusList } from '../../src/vc/BitstringStatusList';
import { StatusListManager } from '../../src/vc/StatusListManager';

/**
 * Status lists moved from node:zlib to fflate so the SDK loads in browsers.
 * node:zlib's `maxOutputLength` threw on a gzip bomb; fflate has no equivalent,
 * and its nearest option (a pre-sized `out` buffer) SILENTLY TRUNCATES. For a
 * status list a truncated bitstring reads as "not revoked" for every entry past
 * the cut — a fail-open verifier. These tests pin the throwing behaviour.
 */
describe('bounded decompression (gzip bomb defence)', () => {
  const MAX = 1_000_000;

  test('rejects a gzip bomb rather than truncating it', () => {
    const bomb = gzipBytes(new Uint8Array(50_000_000));
    expect(bomb.length).toBeLessThan(100_000); // small on the wire, huge inflated
    expect(() => boundedGunzip(bomb, MAX)).toThrow(/exceeded/i);
  });

  test('accepts payloads at or under the budget', () => {
    const payload = new Uint8Array(MAX).fill(0x5a);
    const round = boundedGunzip(gzipBytes(payload), MAX);
    expect(round.length).toBe(MAX);
    expect(round[0]).toBe(0x5a);
    expect(round[MAX - 1]).toBe(0x5a);
  });

  test('rejects one byte over the budget', () => {
    const justOver = gzipBytes(new Uint8Array(MAX + 1));
    expect(() => boundedGunzip(justOver, MAX)).toThrow(/exceeded/i);
  });

  test('stops decompressing on overflow rather than only dropping output', () => {
    // Hardware-independent guard: if INPUT_SLICE_BYTES is removed or inflated to a
    // large value the timing assertion below won't catch it on faster machines.
    // Pin it here so removing slicing is a deterministic failure on any hardware.
    expect(INPUT_SLICE_BYTES).toBeLessThanOrEqual(16384);

    // Bounding memory is not enough: fflate inflates an entire push() before
    // returning, so feeding the whole payload at once burns the full CPU cost of
    // a bomb even though the bytes are discarded. Input is sliced so the budget
    // halts the work. Measured on this 400 MB bomb: ~14 000ms unsliced vs ~136ms
    // sliced on current CI hardware (older measurements: ~920ms vs ~12ms on a
    // faster dev machine). Bomb creation itself also takes several seconds, so
    // the per-test timeout is raised to 30 s to avoid flaky timeout failures
    // when other test files run in parallel and steal CPU.
    const bomb = gzipBytes(new Uint8Array(400_000_000));

    const started = performance.now();
    expect(() => boundedGunzip(bomb, MAX)).toThrow(/exceeded/i);
    const elapsed = performance.now() - started;

    // Bound is set well above the sliced path (~136ms isolated, up to ~700ms
    // under parallel-file CPU load) but well below a single-push regression
    // (~14 000ms). If this assertion starts failing again, check that
    // INPUT_SLICE_BYTES in bounded-decompress.ts is still a small value.
    expect(elapsed).toBeLessThan(3000);
  }, 30000);

  test('rejects truncated and garbage input instead of returning partial data', () => {
    const valid = gzipBytes(new Uint8Array(1000).fill(1));
    expect(() => boundedGunzip(valid.slice(0, 12), MAX)).toThrow();
    expect(() => boundedGunzip(new Uint8Array([1, 2, 3, 4, 5]), MAX)).toThrow();
  });

  test('stays wire-compatible with node:zlib in both directions', () => {
    const data = new Uint8Array(50_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;

    // fflate reads what node:zlib wrote — existing published status lists.
    const fromNode = new Uint8Array(nodeGzip(Buffer.from(data)));
    expect(Array.from(boundedGunzip(fromNode, MAX))).toEqual(Array.from(data));

    // node:zlib reads what fflate writes — other implementations consuming ours.
    expect(Array.from(new Uint8Array(nodeGunzip(Buffer.from(gzipBytes(data))))))
      .toEqual(Array.from(data));
  });

  test('legacy zlib-wrapped DEFLATE decodes via boundedUnzlib', () => {
    // node:zlib's inflateSync accepted ZLIB framing; fflate's inflateSync is raw
    // DEFLATE and rejects it, so the legacy path must use Unzlib.
    const data = new Uint8Array(5000).fill(0x11);
    const legacy = new Uint8Array(nodeDeflate(Buffer.from(data)));
    expect(Array.from(boundedUnzlib(legacy, MAX))).toEqual(Array.from(data));
  });
});

describe('status list encode/decode survives the fflate swap', () => {
  test('BitstringStatusList round-trips a set bit', () => {
    const list = new BitstringStatusList(131072);
    list.set(42);
    list.set(131071);

    const decoded = BitstringStatusList.decode(list.encode());
    expect(decoded.get(42)).toBe(true);
    expect(decoded.get(131071)).toBe(true);
    expect(decoded.get(43)).toBe(false);
  });

  test('BitstringStatusList.encode stays multibase-u and spec-readable', () => {
    const list = new BitstringStatusList(131072);
    list.set(7);
    const encoded = list.encode();
    expect(encoded.startsWith('u')).toBe(true);

    // Cross-check: StatusListManager decodes what BitstringStatusList produced.
    const bits = StatusListManager.decodeBitstring(encoded);
    expect(bits[0] & (1 << (7 - 7))).toBe(1);
  });

  test('a bomb in encodedList is rejected by both decoders', () => {
    const bomb = gzipBytes(new Uint8Array(50_000_000));
    let b64 = '';
    for (let i = 0; i < bomb.length; i += 0x8000) {
      b64 += String.fromCharCode(...bomb.subarray(i, i + 0x8000));
    }
    const encoded = 'u' + btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(() => BitstringStatusList.decode(encoded)).toThrow(/limit|exceeded/i);
    expect(() => StatusListManager.decodeBitstring(encoded)).toThrow(/limit|exceeded/i);
  });
});
