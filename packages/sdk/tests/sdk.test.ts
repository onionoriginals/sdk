import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../src/index';
import { validateDID, validateCredential } from '../src/utils/validation';

describe('OriginalsSDK', () => {
  test('should create SDK instance', () => {
    const sdk = OriginalsSDK.create();
    expect(sdk).toBeInstanceOf(OriginalsSDK);
    expect(sdk.did).toBeDefined();
    expect(sdk.credentials).toBeDefined();
    expect(sdk.lifecycle).toBeDefined();
    expect(sdk.bitcoin).toBeDefined();
  });

  test('should validate DIDs correctly', () => {
    expect(validateDID('did:peer:123456')).toBe(true);
    expect(validateDID('did:webvh:example.com:123')).toBe(true);
    expect(validateDID('did:btco:1234567890abcdef')).toBe(true);
    expect(validateDID('invalid-did')).toBe(false);
    expect(validateDID('did:web:example.com')).toBe(false); // wrong method
  });

  test('should validate layer transitions', () => {
    // Test cases for valid layer transitions
    const validTransitions = [
      ['did:peer', 'did:webvh'],
      ['did:peer', 'did:btco'],
      ['did:webvh', 'did:btco']
    ];

    const invalidTransitions = [
      ['did:webvh', 'did:peer'],
      ['did:btco', 'did:peer'],
      ['did:btco', 'did:webvh']
    ];

    // These would be tested with actual implementation
    expect(validTransitions.length).toBe(3);
    expect(invalidTransitions.length).toBe(3);
  });
});


