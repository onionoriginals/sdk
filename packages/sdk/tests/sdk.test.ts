import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, MemoryStore } from '../src/index';
import { validateDID, validateCredential } from '../src/utils/validation';

describe('OriginalsSDK', () => {
  test('creates an instance over an explicit store and author source', () => {
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    expect(sdk).toBeInstanceOf(OriginalsSDK);
  });

  test('should validate DIDs correctly', () => {
    expect(validateDID('did:key:z6Mk123456')).toBe(true);
    expect(validateDID('did:vh:QmExample')).toBe(true);
    expect(validateDID('did:webvh:example.com:123')).toBe(true);
    expect(validateDID('did:btco:1234567890abcdef')).toBe(true);
    expect(validateDID('invalid-did')).toBe(false);
    expect(validateDID('did:web:example.com')).toBe(false); // wrong method
    expect(validateDID('did:peer:123456')).toBe(false); // did:peer support removed
    expect(validateDID('did:cel:uEiExample')).toBe(false); // CEL 3 identifiers were deleted (plan 011 PR 5)
  });

  test('validateCredential requires the VCDM 2.0 context', () => {
    expect(validateCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'] } as never)).toBe(false);
  });
});
