import { describe, test, expect } from 'bun:test';
import {
  hexToBytes,
  base64,
  utf8,
  base64url,
  base58,
  multibase,
  multikey,
  MULTIBASE_BASE58BTC_HEADER,
  MULTIBASE_BASE64URL_HEADER,
  MULTICODEC_ED25519_PUB_HEADER,
  MULTICODEC_SECP256K1_PUB_HEADER,
} from '../../../src/utils/encoding';

describe('utils/encoding', () => {
  describe('hexToBytes', () => {
    test('decodes even-length hex', () => {
      const u8 = hexToBytes('0a0b0c');
      expect(Array.from(u8)).toEqual([10, 11, 12]);
    });

    test('supports 0x prefix', () => {
      const u8 = hexToBytes('0x0aff');
      expect(Array.from(u8)).toEqual([10, 255]);
    });

    test('throws on odd length', () => {
      expect(() => hexToBytes('abc')).toThrow('Invalid hex string length');
    });

    test('throws on invalid characters', () => {
      expect(() => hexToBytes('zz')).toThrow('Invalid hex string');
    });
  });

  describe('base64', () => {
    test('encodes Uint8Array to base64', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = base64.encode(input);
      expect(encoded).toBe('AQIDBAU=');
    });

    test('decodes base64 to Uint8Array', () => {
      const encoded = 'AQIDBAU=';
      const decoded = base64.decode(encoded);
      expect(decoded).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    test('roundtrip encode/decode', () => {
      const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
      const encoded = base64.encode(original);
      const decoded = base64.decode(encoded);
      expect(decoded).toEqual(original);
    });

    test('handles empty input', () => {
      const encoded = base64.encode(new Uint8Array([]));
      const decoded = base64.decode(encoded);
      expect(decoded).toEqual(new Uint8Array([]));
    });

    test('handles string input', () => {
      const encoded = base64.encode('hello');
      expect(encoded).toBe('aGVsbG8=');
    });

    test('decodes empty string', () => {
      const decoded = base64.decode('');
      expect(decoded).toEqual(new Uint8Array([]));
    });
  });

  describe('utf8', () => {
    test('encodes string to Uint8Array', () => {
      const input = 'hello';
      const encoded = utf8.encode(input);
      expect(encoded).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    test('decodes Uint8Array to string', () => {
      const input = new Uint8Array([104, 101, 108, 108, 111]);
      const decoded = utf8.decode(input);
      expect(decoded).toBe('hello');
    });

    test('roundtrip encode/decode', () => {
      const original = 'Hello, World! 🌍';
      const encoded = utf8.encode(original);
      const decoded = utf8.decode(encoded);
      expect(decoded).toBe(original);
    });

    test('handles special characters', () => {
      const original = 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?';
      const encoded = utf8.encode(original);
      const decoded = utf8.decode(encoded);
      expect(decoded).toBe(original);
    });

    test('handles unicode characters', () => {
      const original = '日本語 한글 中文 العربية';
      const encoded = utf8.encode(original);
      const decoded = utf8.decode(encoded);
      expect(decoded).toBe(original);
    });

    test('handles empty string', () => {
      const encoded = utf8.encode('');
      expect(encoded).toEqual(new Uint8Array([]));
      const decoded = utf8.decode(new Uint8Array([]));
      expect(decoded).toBe('');
    });
  });

  describe('base64url', () => {
    test('encodes Uint8Array to base64url', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = base64url.encode(input);
      // base64url should not have padding (=) and should use - and _ instead of + and /
      expect(encoded).toBe('AQIDBAU');
      expect(encoded).not.toContain('=');
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
    });

    test('decodes base64url to Uint8Array', () => {
      const encoded = 'AQIDBAU';
      const decoded = base64url.decode(encoded);
      expect(decoded).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    test('roundtrip encode/decode', () => {
      const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
      const encoded = base64url.encode(original);
      const decoded = base64url.decode(encoded);
      expect(decoded).toEqual(original);
    });

    test('handles characters that need base64url encoding', () => {
      // Create data that would produce + and / in regular base64
      const input = new Uint8Array([0xfb, 0xff, 0xbf]); // This produces +/ in base64
      const encoded = base64url.encode(input);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).toContain('-'); // Should use - instead of +
      expect(encoded).toContain('_'); // Should use _ instead of /
    });

    test('handles empty input', () => {
      const encoded = base64url.encode(new Uint8Array([]));
      const decoded = base64url.decode(encoded);
      expect(decoded).toEqual(new Uint8Array([]));
    });
  });

  describe('base58', () => {
    test('encodes Uint8Array to base58', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = base58.encode(input);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);
    });

    test('decodes base58 to Uint8Array', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = base58.encode(input);
      const decoded = base58.decode(encoded);
      expect(decoded).toEqual(input);
    });

    test('roundtrip encode/decode', () => {
      const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
      const encoded = base58.encode(original);
      const decoded = base58.decode(encoded);
      expect(decoded).toEqual(original);
    });

    test('handles empty input', () => {
      const original = new Uint8Array([]);
      const encoded = base58.encode(original);
      const decoded = base58.decode(encoded);
      expect(decoded).toEqual(original);
    });
  });

  describe('multibase', () => {
    describe('base58btc encoding', () => {
      test('encodes with base58btc prefix', () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = multibase.encode(input, 'base58btc');
        expect(encoded.startsWith(MULTIBASE_BASE58BTC_HEADER)).toBe(true);
      });

      test('decodes base58btc encoded string', () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = multibase.encode(input, 'base58btc');
        const decoded = multibase.decode(encoded);
        expect(decoded).toEqual(input);
      });

      test('roundtrip encode/decode with base58btc', () => {
        const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
        const encoded = multibase.encode(original, 'base58btc');
        const decoded = multibase.decode(encoded);
        expect(decoded).toEqual(original);
      });
    });

    describe('base64url encoding', () => {
      test('encodes with base64url prefix', () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = multibase.encode(input, 'base64url');
        expect(encoded.startsWith(MULTIBASE_BASE64URL_HEADER)).toBe(true);
      });

      test('decodes base64url encoded string', () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = multibase.encode(input, 'base64url');
        const decoded = multibase.decode(encoded);
        expect(decoded).toEqual(input);
      });

      test('roundtrip encode/decode with base64url', () => {
        const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
        const encoded = multibase.encode(original, 'base64url');
        const decoded = multibase.decode(encoded);
        expect(decoded).toEqual(original);
      });
    });

    test('throws error for invalid encoding type', () => {
      const input = new Uint8Array([1, 2, 3]);
      expect(() => multibase.encode(input, 'invalid' as any)).toThrow('Invalid multibase encoding.');
    });

    test('throws error for missing base58btc header in decode', () => {
      expect(() => multibase.decode('abc123')).toThrow('Multibase value does not have expected header.');
    });

    test('throws error for missing base64url header in decode', () => {
      expect(() => multibase.decode('xyz456')).toThrow('Multibase value does not have expected header.');
    });

    test('handles empty input', () => {
      const empty = new Uint8Array([]);
      const encoded1 = multibase.encode(empty, 'base58btc');
      const decoded1 = multibase.decode(encoded1);
      expect(decoded1).toEqual(empty);

      const encoded2 = multibase.encode(empty, 'base64url');
      const decoded2 = multibase.decode(encoded2);
      expect(decoded2).toEqual(empty);
    });
  });

  describe('multikey', () => {
    test('encodes with Ed25519 header', () => {
      const keyBytes = new Uint8Array(32).fill(1);
      const encoded = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, keyBytes);
      expect(encoded.startsWith(MULTIBASE_BASE58BTC_HEADER)).toBe(true);
    });

    test('decodes with Ed25519 header', () => {
      const keyBytes = new Uint8Array(32).fill(1);
      const encoded = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, keyBytes);
      const decoded = multikey.decode(MULTICODEC_ED25519_PUB_HEADER, encoded);
      expect(decoded).toEqual(keyBytes);
    });

    test('roundtrip encode/decode with Ed25519 header', () => {
      const original = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        original[i] = i;
      }
      const encoded = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, original);
      const decoded = multikey.decode(MULTICODEC_ED25519_PUB_HEADER, encoded);
      expect(decoded).toEqual(original);
    });

    test('encodes with secp256k1 header', () => {
      const keyBytes = new Uint8Array(33).fill(2);
      const encoded = multikey.encode(MULTICODEC_SECP256K1_PUB_HEADER, keyBytes);
      expect(encoded.startsWith(MULTIBASE_BASE58BTC_HEADER)).toBe(true);
    });

    test('decodes with secp256k1 header', () => {
      const keyBytes = new Uint8Array(33).fill(2);
      const encoded = multikey.encode(MULTICODEC_SECP256K1_PUB_HEADER, keyBytes);
      const decoded = multikey.decode(MULTICODEC_SECP256K1_PUB_HEADER, encoded);
      expect(decoded).toEqual(keyBytes);
    });

    test('throws error when header does not match', () => {
      const keyBytes = new Uint8Array(32).fill(1);
      const encoded = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, keyBytes);

      // Try to decode with wrong header
      expect(() => multikey.decode(MULTICODEC_SECP256K1_PUB_HEADER, encoded))
        .toThrow('Multikey value does not have expected header.');
    });

    test('handles different key sizes', () => {
      // Test with 32-byte key (Ed25519)
      const key32 = new Uint8Array(32).fill(3);
      const encoded32 = multikey.encode(MULTICODEC_ED25519_PUB_HEADER, key32);
      const decoded32 = multikey.decode(MULTICODEC_ED25519_PUB_HEADER, encoded32);
      expect(decoded32).toEqual(key32);

      // Test with 33-byte key (secp256k1)
      const key33 = new Uint8Array(33).fill(4);
      const encoded33 = multikey.encode(MULTICODEC_SECP256K1_PUB_HEADER, key33);
      const decoded33 = multikey.decode(MULTICODEC_SECP256K1_PUB_HEADER, encoded33);
      expect(decoded33).toEqual(key33);
    });
  });
});

