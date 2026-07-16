import { describe, test, expect } from 'bun:test';
import { initEd25519, initSecp256k1, initNobleCrypto } from '../../../src/crypto/noble-init';

/**
 * Simulate a strict-ESM browser bundle namespace: `hashes` exists only as a
 * non-configurable binding whose value is `undefined`, and the object is
 * non-extensible. Before the fix, initEd25519/initSecp256k1 did a raw
 * `Object.defineProperty(mod, 'hashes', …)` here and threw
 * "Cannot redefine property: hashes" — white-screening any browser app that
 * merely imported the SDK.
 */
function frozenNamespace(): unknown {
  const ns: Record<string, unknown> = {};
  Object.defineProperty(ns, 'hashes', {
    value: undefined,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.preventExtensions(ns);
  return ns;
}

describe('noble-init browser hardening', () => {
  test('initEd25519 does not throw on a frozen module namespace', () => {
    expect(() => initEd25519(frozenNamespace())).not.toThrow();
  });

  test('initSecp256k1 does not throw on a frozen module namespace', () => {
    expect(() => initSecp256k1(frozenNamespace())).not.toThrow();
  });

  test('initEd25519 configures hashes.sha512 on a normal mutable module', () => {
    const mod: { hashes?: Record<string, unknown> } = {};
    initEd25519(mod);
    expect(typeof mod.hashes?.sha512).toBe('function');
  });

  test('initSecp256k1 configures hashes.sha256 + hmacSha256 on a normal module', () => {
    const mod: { hashes?: Record<string, unknown> } = {};
    initSecp256k1(mod);
    expect(typeof mod.hashes?.sha256).toBe('function');
    expect(typeof mod.hashes?.hmacSha256).toBe('function');
  });

  test('does not clobber a hash impl that is already set', () => {
    const existing = (msg: Uint8Array) => msg;
    const mod = { hashes: { sha512: existing } as Record<string, unknown> };
    initEd25519(mod);
    expect(mod.hashes.sha512).toBe(existing);
  });

  test('initNobleCrypto (real modules) is idempotent and does not throw', () => {
    expect(() => initNobleCrypto()).not.toThrow();
  });
});
