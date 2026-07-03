import { describe, test, expect } from 'bun:test';
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

describe('CBOR round-trip correctness (issue #236)', () => {
  test('strings containing U+E000–U+FFFF code points round-trip unchanged', () => {
    const samples = [
      '你好，世界',            // fullwidth comma U+FF0C inside CJK text
      '，',                // fullwidth comma alone
      '',          // private-use area boundaries
      '豈﫿',          // CJK compatibility ideographs
      '＀￯',          // halfwidth/fullwidth forms block boundaries
      'ﬁﬂ',          // ligatures fi fl
      'ﷺ',                // Arabic presentation form
      'ｶﾀｶﾅ',                  // halfwidth katakana
      '１２３ＡＢＣ',           // fullwidth digits/letters
      '�',                // replacement character
    ];
    for (const s of samples) {
      expect(decode(encode({ x: s }))).toEqual({ x: s });
    }
  });

  test('surrogate-pair (astral) and low-BMP strings still round-trip', () => {
    const samples = ['🎉🚀', '𐍈', 'héllo wörld', '한국어', '日本語テスト', 'ascii'];
    for (const s of samples) {
      expect(decode(encode(s))).toBe(s);
    }
  });

  test('nested structures with mixed types round-trip', () => {
    const value = {
      str: '，test，',
      num: 42,
      float: 1.5,
      neg: -7,
      bool: true,
      nil: null,
      arr: [1, 'two', { deep: '｟nested｠' }],
      bytes: new Uint8Array([0, 1, 2, 255])
    };
    const out = decode<typeof value>(encode(value));
    expect(out.str).toBe(value.str);
    expect(out.num).toBe(42);
    expect(out.float).toBe(1.5);
    expect(out.neg).toBe(-7);
    expect(out.bool).toBe(true);
    expect(out.nil).toBeNull();
    expect(out.arr[0]).toBe(1);
    expect(out.arr[1]).toBe('two');
    expect((out.arr[2] as any).deep).toBe('｟nested｠');
    expect(new Uint8Array(out.bytes as Uint8Array)).toEqual(value.bytes);
  });

  test('decode of a __proto__ map key does not pollute the prototype (issue #278)', () => {
    // CBOR map { "__proto__": { "polluted": true }, "x": 1 }
    const malicious = encode({ ['__proto__']: { polluted: true }, x: 1 });
    let decoded: any;
    try {
      decoded = decode(malicious);
    } catch {
      // rejecting outright is also acceptable
      return;
    }
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  test('malformed input throws instead of returning garbage', () => {
    expect(() => decode(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
    expect(() => decode(new Uint8Array([]))).toThrow();
  });
});

