import { describe, test, expect } from 'bun:test';
import { hexToBytes } from '../../../src/utils/encoding';

describe('utils/encoding', () => {
  test('hexToBytes decodes even-length hex', () => {
    const u8 = hexToBytes('0a0b0c');
    expect(Array.from(u8)).toEqual([10, 11, 12]);
  });

  test('hexToBytes supports 0x prefix', () => {
    const u8 = hexToBytes('0x0aff');
    expect(Array.from(u8)).toEqual([10, 255]);
  });

  test('hexToBytes throws on odd length', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string length');
  });

  test('hexToBytes throws on invalid characters', () => {
    expect(() => hexToBytes('zz')).toThrow('Invalid hex string');
  });
});

