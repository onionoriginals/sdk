import { encode, decode } from '../../../src/utils/cbor';

describe('utils/cbor', () => {
  test('encode returns Uint8Array', () => {
    const input = { a: 1, b: 'two' };
    const out = encode(input);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });

  test('decode roundtrips object', () => {
    const input = { a: 1, b: 'two', nested: { ok: true } };
    const encoded = encode(input);
    const decoded = decode<typeof input>(encoded);
    expect(decoded).toEqual(input);
  });

  test('decode accepts Buffer', () => {
    const input = [1, 2, 3];
    const encoded = encode(input);
    const buf = Buffer.from(encoded);
    const decoded = decode<number[]>(buf);
    expect(decoded).toEqual(input);
  });

  test('decode accepts ArrayBuffer', () => {
    const input = { hello: 'world' };
    const encoded = encode(input);
    const ab = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    const decoded = decode<typeof input>(ab as ArrayBuffer);
    expect(decoded).toEqual(input);
  });
});

