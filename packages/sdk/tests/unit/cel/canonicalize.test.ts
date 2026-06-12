/**
 * Unit tests for canonicalizeEvent
 *
 * These tests document and guard against the critical bug where
 * `JSON.stringify(x, Object.keys(x).sort())` silently drops nested keys
 * because an array replacer acts as a key allowlist at every nesting level.
 */

import { describe, test, expect } from 'bun:test';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';

const decoder = new TextDecoder();

describe('canonicalizeEvent', () => {
  test('nested object keys are fully preserved (regression for allowlist bug)', () => {
    const input = {
      type: 'create',
      data: { name: 'x', nested: { b: 1, a: 2 } },
    };

    const bytes = canonicalizeEvent(input);
    const json = decoder.decode(bytes);

    // All nested keys must be present — the old allowlist bug would have
    // dropped "name", "nested", "a", and "b" because they were not in the
    // top-level key array ['data', 'type'].
    expect(json).toContain('"name"');
    expect(json).toContain('"nested"');
    expect(json).toContain('"a"');
    expect(json).toContain('"b"');
  });

  test('keys are sorted lexicographically at every nesting level', () => {
    const input = {
      type: 'create',
      data: { name: 'x', nested: { b: 1, a: 2 } },
    };

    const bytes = canonicalizeEvent(input);
    const json = decoder.decode(bytes);

    // Top-level: data < type
    // data level: name < nested
    // nested level: a < b
    expect(json).toEqual('{"data":{"name":"x","nested":{"a":2,"b":1}},"type":"create"}');
  });

  test('arrays are preserved in insertion order with objects inside also key-sorted', () => {
    const input = {
      items: [
        { z: 3, a: 1 },
        { m: 2, b: 4 },
      ],
      label: 'test',
    };

    const bytes = canonicalizeEvent(input);
    const json = decoder.decode(bytes);

    // Arrays preserve order; objects inside arrays are key-sorted
    expect(json).toEqual('{"items":[{"a":1,"z":3},{"b":4,"m":2}],"label":"test"}');
  });

  test('demonstrative negative: old JSON.stringify array-replacer pattern drops nested keys', () => {
    const input = {
      type: 'create',
      data: { name: 'x', nested: { b: 1, a: 2 } },
    };

    // The OLD broken pattern: array replacer is a per-level allowlist.
    // Top-level keys of `input` are ['type', 'data']. Any nested key not in
    // that list — 'name', 'nested', 'a', 'b' — is silently omitted.
    const brokenJson = JSON.stringify(input, Object.keys(input).sort());

    // Proves the old pattern drops nested content
    expect(brokenJson).not.toContain('"name"');
    expect(brokenJson).not.toContain('"nested"');

    // But canonicalizeEvent produces complete output
    const correctJson = decoder.decode(canonicalizeEvent(input));
    expect(correctJson).toContain('"name"');
    expect(correctJson).toContain('"nested"');

    // And the two results differ
    expect(brokenJson).not.toEqual(correctJson);
  });
});
