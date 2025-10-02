import { 
  validateSatoshiNumber, 
  parseSatoshiIdentifier, 
  assertValidSatoshi,
  MAX_SATOSHI_SUPPLY 
} from '../../../src/utils/satoshi-validation';
import { StructuredError } from '../../../src/utils/telemetry';

describe('satoshi-validation', () => {
  describe('validateSatoshiNumber', () => {
    describe('valid satoshi numbers', () => {
      test('accepts zero', () => {
        const result = validateSatoshiNumber(0);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts one', () => {
        const result = validateSatoshiNumber(1);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts valid positive number', () => {
        const result = validateSatoshiNumber(123456789);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts string representation of valid number', () => {
        const result = validateSatoshiNumber('123456789');
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts maximum supply', () => {
        const result = validateSatoshiNumber(MAX_SATOSHI_SUPPLY);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts maximum supply as string', () => {
        const result = validateSatoshiNumber(String(MAX_SATOSHI_SUPPLY));
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      test('accepts large valid ordinal number', () => {
        const result = validateSatoshiNumber('1066296127976657');
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe('invalid formats', () => {
      test('rejects null', () => {
        const result = validateSatoshiNumber(null as any);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be null, undefined, or empty string');
      });

      test('rejects undefined', () => {
        const result = validateSatoshiNumber(undefined as any);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be null, undefined, or empty string');
      });

      test('rejects empty string', () => {
        const result = validateSatoshiNumber('');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be null, undefined, or empty string');
      });

      test('rejects whitespace-only string', () => {
        const result = validateSatoshiNumber('   ');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty or whitespace-only string');
      });

      test('rejects negative number', () => {
        const result = validateSatoshiNumber(-1);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects negative string', () => {
        const result = validateSatoshiNumber('-123');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects decimal number', () => {
        const result = validateSatoshiNumber(123.456);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects decimal string', () => {
        const result = validateSatoshiNumber('123.456');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects scientific notation', () => {
        const result = validateSatoshiNumber('1e5');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects non-numeric string', () => {
        const result = validateSatoshiNumber('abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects alphanumeric string', () => {
        const result = validateSatoshiNumber('123abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects string with spaces', () => {
        const result = validateSatoshiNumber('123 456');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects infinity', () => {
        const result = validateSatoshiNumber(Infinity);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });

      test('rejects NaN', () => {
        const result = validateSatoshiNumber(NaN);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-negative integer');
      });
    });

    describe('range validation', () => {
      test('rejects value exceeding maximum supply', () => {
        const result = validateSatoshiNumber(MAX_SATOSHI_SUPPLY + 1);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("within Bitcoin's total supply");
      });

      test('rejects extremely large value', () => {
        const result = validateSatoshiNumber('999999999999999999');
        expect(result.valid).toBe(false);
        expect(result.error).toContain("within Bitcoin's total supply");
      });

      test('accepts value at boundary', () => {
        const result = validateSatoshiNumber(MAX_SATOSHI_SUPPLY);
        expect(result.valid).toBe(true);
      });

      test('accepts value just below boundary', () => {
        const result = validateSatoshiNumber(MAX_SATOSHI_SUPPLY - 1);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('parseSatoshiIdentifier', () => {
    describe('plain satoshi numbers', () => {
      test('parses valid plain number string', () => {
        const result = parseSatoshiIdentifier('123456');
        expect(result).toBe(123456);
      });

      test('parses zero', () => {
        const result = parseSatoshiIdentifier('0');
        expect(result).toBe(0);
      });

      test('parses large ordinal', () => {
        const result = parseSatoshiIdentifier('1066296127976657');
        expect(result).toBe(1066296127976657);
      });
    });

    describe('did:btco DIDs', () => {
      test('extracts satoshi from mainnet DID', () => {
        const result = parseSatoshiIdentifier('did:btco:123456');
        expect(result).toBe(123456);
      });

      test('extracts satoshi from testnet DID', () => {
        const result = parseSatoshiIdentifier('did:btco:test:123456');
        expect(result).toBe(123456);
      });

      test('extracts satoshi from signet DID', () => {
        const result = parseSatoshiIdentifier('did:btco:sig:789012');
        expect(result).toBe(789012);
      });

      test('extracts large ordinal from DID', () => {
        const result = parseSatoshiIdentifier('did:btco:1066296127976657');
        expect(result).toBe(1066296127976657);
      });

      test('handles whitespace around DID', () => {
        const result = parseSatoshiIdentifier('  did:btco:123456  ');
        expect(result).toBe(123456);
      });
    });

    describe('error handling', () => {
      test('throws on empty string', () => {
        expect(() => parseSatoshiIdentifier('')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('')).toThrow('non-empty string');
      });

      test('throws on whitespace-only string', () => {
        expect(() => parseSatoshiIdentifier('   ')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('   ')).toThrow('cannot be empty');
      });

      test('throws on null', () => {
        expect(() => parseSatoshiIdentifier(null as any)).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier(null as any)).toThrow('must be a non-empty string');
      });

      test('throws on invalid satoshi in DID', () => {
        expect(() => parseSatoshiIdentifier('did:btco:-123')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco:-123')).toThrow('non-negative integer');
      });

      test('throws on invalid satoshi format', () => {
        expect(() => parseSatoshiIdentifier('abc')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('abc')).toThrow('non-negative integer');
      });

      test('throws on decimal satoshi', () => {
        expect(() => parseSatoshiIdentifier('123.456')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('123.456')).toThrow('non-negative integer');
      });

      test('throws on satoshi exceeding max supply', () => {
        const tooLarge = String(MAX_SATOSHI_SUPPLY + 1);
        expect(() => parseSatoshiIdentifier(tooLarge)).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier(tooLarge)).toThrow("within Bitcoin's total supply");
      });

      test('throws on invalid did:btco format with too few parts', () => {
        expect(() => parseSatoshiIdentifier('did:btco')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco')).toThrow('non-negative integer');
      });

      test('throws on invalid did:btco format with too many parts', () => {
        expect(() => parseSatoshiIdentifier('did:btco:test:123:extra')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco:test:123:extra')).toThrow('Invalid did:btco DID format');
      });

      test('throws on invalid network in did:btco', () => {
        expect(() => parseSatoshiIdentifier('did:btco:invalid:123')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco:invalid:123')).toThrow('unsupported network');
      });

      test('throws on mainnet prefix in 4-part format', () => {
        // mainnet should use 3-part format (did:btco:123), not 4-part (did:btco:mainnet:123)
        expect(() => parseSatoshiIdentifier('did:btco:mainnet:123')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco:mainnet:123')).toThrow('unsupported network');
      });

      test('throws on regtest prefix', () => {
        expect(() => parseSatoshiIdentifier('did:btco:regtest:123')).toThrow(StructuredError);
        expect(() => parseSatoshiIdentifier('did:btco:regtest:123')).toThrow('unsupported network');
      });
    });

    describe('validation integration', () => {
      test('validates extracted satoshi', () => {
        expect(() => parseSatoshiIdentifier('did:btco:test:-1')).toThrow();
        expect(() => parseSatoshiIdentifier('did:btco:abc')).toThrow();
      });
    });
  });

  describe('assertValidSatoshi', () => {
    test('does not throw for valid satoshi', () => {
      expect(() => assertValidSatoshi(123456)).not.toThrow();
      expect(() => assertValidSatoshi('123456')).not.toThrow();
      expect(() => assertValidSatoshi(0)).not.toThrow();
    });

    test('throws StructuredError for invalid satoshi', () => {
      expect(() => assertValidSatoshi('')).toThrow(StructuredError);
      expect(() => assertValidSatoshi(-1)).toThrow(StructuredError);
      expect(() => assertValidSatoshi('abc')).toThrow(StructuredError);
    });

    test('throws with error code INVALID_SATOSHI', () => {
      try {
        assertValidSatoshi('');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(StructuredError);
        expect(error.code).toBe('INVALID_SATOSHI');
      }
    });

    test('includes descriptive error message', () => {
      try {
        assertValidSatoshi('');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('cannot be null, undefined, or empty string');
      }
    });
  });

  describe('edge cases', () => {
    test('handles zero correctly', () => {
      expect(validateSatoshiNumber(0).valid).toBe(true);
      expect(validateSatoshiNumber('0').valid).toBe(true);
      expect(parseSatoshiIdentifier('0')).toBe(0);
    });

    test('handles very long valid number string', () => {
      const longValid = '100000000000000';
      expect(validateSatoshiNumber(longValid).valid).toBe(true);
      expect(parseSatoshiIdentifier(longValid)).toBe(100000000000000);
    });

    test('trims whitespace from input', () => {
      expect(validateSatoshiNumber('  123  ').valid).toBe(true);
      expect(parseSatoshiIdentifier('  123  ')).toBe(123);
    });
  });
});
