import { test, expect } from 'bun:test';
import { demo } from '../content';
import { inscribeCostNote } from './Demo';

test('the unavailable Bitcoin step explains costs without quoting a previous-format payload', () => {
  expect(inscribeCostNote(false)).toBe(demo.inscribeCost);
  expect(demo.inscribeCost).toMatch(/live fee quote/i);
  expect(demo.inscribeCost).toMatch(/resource bytes and signed history/i);
  expect(demo.inscribeCost).not.toMatch(/simulation|4,100|18,100|exact amount/i);
  expect(demo.inscribeCost).toMatch(/not refundable/i);
});

test('the real deposit flow owns the live fee figure', () => {
  expect(inscribeCostNote(true)).toBeNull();
});
