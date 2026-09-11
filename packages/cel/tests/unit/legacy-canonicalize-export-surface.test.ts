/**
 * Regression for issue #599: the previous-format canonicalizer
 * (`canonicalizeEvent` and its derivatives) must not be reachable from the
 * `@originals/cel` package root, only from the explicit `@originals/cel/legacy`
 * compatibility subpath — and it must stay byte-for-byte identical there, since
 * previous-format signed history depends on these exact preimages.
 */

import { describe, test, expect } from 'bun:test';
import * as root from '../../src/index';
import * as legacy from '../../src/legacy';

const LEGACY_CANONICALIZE_NAMES = [
  'canonicalizeEvent',
  'witnessSigningBytes',
  'canonicalizeEntryForChain',
  'committedFields',
  'celProofSigningInput',
] as const;

describe('legacy canonicalize export surface', () => {
  test('the package root has no own previous-format canonicalize exports', () => {
    for (const name of LEGACY_CANONICALIZE_NAMES) {
      expect(Object.prototype.hasOwnProperty.call(root, name)).toBe(false);
    }
  });

  test('@originals/cel/legacy exposes all previous-format canonicalize primitives as functions', () => {
    for (const name of LEGACY_CANONICALIZE_NAMES) {
      expect(typeof (legacy as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('the CEL 3 root path (celV3) never routes through the legacy canonicalizer', () => {
    // canonicalizeValue is CEL 3's own RFC 8785 serializer (packages/cel/src/v3/values.ts);
    // it must not be, and is not, the same function as the legacy one.
    expect((root as any).celV3.canonicalizeValue).not.toBe(legacy.canonicalizeEvent);
    expect(typeof (root as any).celV3.canonicalizeValue).toBe('function');
  });

  test('legacy.canonicalizeEvent output is unchanged (locks in the exact previous-format preimage)', () => {
    const decoder = new TextDecoder();
    const bytes = legacy.canonicalizeEvent({
      type: 'create',
      data: { name: 'x', nested: { b: 1, a: 2 } },
    });
    expect(decoder.decode(bytes)).toEqual(
      '{"data":{"name":"x","nested":{"a":2,"b":1}},"type":"create"}'
    );
  });

  test(
    'documents the known defect that keeps this canonicalizer compat-only: ' +
      'an own `__proto__` data member is silently dropped',
    () => {
      // JSON.parse (unlike assignment) creates a genuine own property for a
      // "__proto__" member, so this is a realistic wire payload, not a
      // synthetic construction.
      const data = JSON.parse('{"__proto__":"smuggled","visible":1}') as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);

      const decoder = new TextDecoder();
      const legacyJson = decoder.decode(legacy.canonicalizeEvent(data));
      // The known defect: the own `__proto__` member never reaches the output.
      expect(legacyJson).not.toContain('smuggled');
      expect(legacyJson).toContain('"visible":1');

      // CEL 3's canonicalizeValue (the default, root-reachable path via
      // `celV3`) copies into a null-prototype object first and does not lose
      // the member — this is the "existing CEL 3 __proto__ ... regression"
      // referenced by issue #599 as the conformance gate to keep.
      const v3Json = (root as any).celV3.canonicalizeValue(data);
      expect(v3Json).toContain('smuggled');
      expect(v3Json).toContain('"visible":1');
    }
  );
});
