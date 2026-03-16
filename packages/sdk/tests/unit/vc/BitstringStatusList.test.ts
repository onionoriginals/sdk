import { describe, test, expect } from 'bun:test';
import { BitstringStatusList } from '../../../src/vc/BitstringStatusList';

describe('BitstringStatusList', () => {
  describe('constructor', () => {
    test('creates a list with default length (131072)', () => {
      const list = new BitstringStatusList();
      expect(list.length).toBe(131072);
    });

    test('creates a list with custom length', () => {
      const list = new BitstringStatusList(262144);
      expect(list.length).toBe(262144);
    });

    test('throws on length below minimum (131072)', () => {
      expect(() => new BitstringStatusList(1000)).toThrow(/at least 131072/);
    });

    test('throws on length of 0', () => {
      expect(() => new BitstringStatusList(0)).toThrow(/at least 131072/);
    });

    test('accepts exactly 131072', () => {
      const list = new BitstringStatusList(131072);
      expect(list.length).toBe(131072);
    });
  });

  describe('set / get', () => {
    test('bit defaults to false (unset)', () => {
      const list = new BitstringStatusList();
      expect(list.get(0)).toBe(false);
      expect(list.get(1000)).toBe(false);
      expect(list.get(131071)).toBe(false);
    });

    test('sets and gets a single bit', () => {
      const list = new BitstringStatusList();
      list.set(42);
      expect(list.get(42)).toBe(true);
    });

    test('set does not affect adjacent bits', () => {
      const list = new BitstringStatusList();
      list.set(42);
      expect(list.get(41)).toBe(false);
      expect(list.get(43)).toBe(false);
    });

    test('sets multiple bits independently', () => {
      const list = new BitstringStatusList();
      list.set(0);
      list.set(7);
      list.set(8);
      list.set(1000);
      list.set(131071);

      expect(list.get(0)).toBe(true);
      expect(list.get(7)).toBe(true);
      expect(list.get(8)).toBe(true);
      expect(list.get(1000)).toBe(true);
      expect(list.get(131071)).toBe(true);
      expect(list.get(1)).toBe(false);
      expect(list.get(999)).toBe(false);
    });

    test('setting an already-set bit is idempotent', () => {
      const list = new BitstringStatusList();
      list.set(10);
      list.set(10);
      expect(list.get(10)).toBe(true);
    });
  });

  describe('clear', () => {
    test('clears a set bit', () => {
      const list = new BitstringStatusList();
      list.set(42);
      expect(list.get(42)).toBe(true);
      list.clear(42);
      expect(list.get(42)).toBe(false);
    });

    test('clearing an unset bit is a no-op', () => {
      const list = new BitstringStatusList();
      list.clear(42);
      expect(list.get(42)).toBe(false);
    });

    test('clear does not affect other bits', () => {
      const list = new BitstringStatusList();
      list.set(10);
      list.set(11);
      list.clear(10);
      expect(list.get(10)).toBe(false);
      expect(list.get(11)).toBe(true);
    });
  });

  describe('MSB-first bit ordering', () => {
    test('bit 0 is the MSB of byte 0', () => {
      const list = new BitstringStatusList();
      list.set(0);
      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded);
      expect(decoded.get(0)).toBe(true);
      expect(decoded.get(1)).toBe(false);
      expect(decoded.get(7)).toBe(false);
    });

    test('bit 7 is the LSB of byte 0', () => {
      const list = new BitstringStatusList();
      list.set(7);
      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded);
      expect(decoded.get(7)).toBe(true);
      expect(decoded.get(0)).toBe(false);
      expect(decoded.get(6)).toBe(false);
    });

    test('bit 8 is the MSB of byte 1', () => {
      const list = new BitstringStatusList();
      list.set(8);
      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded);
      expect(decoded.get(8)).toBe(true);
      expect(decoded.get(7)).toBe(false);
      expect(decoded.get(9)).toBe(false);
    });
  });

  describe('encode / decode', () => {
    test('roundtrips an empty list', () => {
      const list = new BitstringStatusList();
      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded);
      expect(decoded.length).toBe(list.length);
      expect(decoded.get(0)).toBe(false);
      expect(decoded.get(131071)).toBe(false);
    });

    test('roundtrips a list with set bits', () => {
      const list = new BitstringStatusList();
      const indices = [0, 7, 8, 42, 1000, 50000, 131071];
      for (const i of indices) {
        list.set(i);
      }

      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded);

      for (const i of indices) {
        expect(decoded.get(i)).toBe(true);
      }
      expect(decoded.get(1)).toBe(false);
      expect(decoded.get(43)).toBe(false);
    });

    test('encoded string is a non-empty string', () => {
      const list = new BitstringStatusList();
      const encoded = list.encode();
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);
    });

    test('decode with explicit length', () => {
      const list = new BitstringStatusList(262144);
      list.set(200000);
      const encoded = list.encode();
      const decoded = BitstringStatusList.decode(encoded, 262144);
      expect(decoded.get(200000)).toBe(true);
      expect(decoded.length).toBe(262144);
    });
  });

  describe('boundary validation', () => {
    test('throws RangeError on negative index for set', () => {
      const list = new BitstringStatusList();
      expect(() => list.set(-1)).toThrow(RangeError);
    });

    test('throws RangeError on negative index for get', () => {
      const list = new BitstringStatusList();
      expect(() => list.get(-1)).toThrow(RangeError);
    });

    test('throws RangeError on negative index for clear', () => {
      const list = new BitstringStatusList();
      expect(() => list.clear(-1)).toThrow(RangeError);
    });

    test('throws RangeError on index >= length for set', () => {
      const list = new BitstringStatusList();
      expect(() => list.set(131072)).toThrow(RangeError);
    });

    test('throws RangeError on index >= length for get', () => {
      const list = new BitstringStatusList();
      expect(() => list.get(131072)).toThrow(RangeError);
    });

    test('throws RangeError on index >= length for clear', () => {
      const list = new BitstringStatusList();
      expect(() => list.clear(131072)).toThrow(RangeError);
    });

    test('throws RangeError on non-integer index', () => {
      const list = new BitstringStatusList();
      expect(() => list.set(1.5)).toThrow(RangeError);
    });

    test('last valid index works correctly', () => {
      const list = new BitstringStatusList();
      list.set(131071);
      expect(list.get(131071)).toBe(true);
    });
  });
});
