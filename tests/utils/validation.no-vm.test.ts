import { validateDIDDocument } from '../../src/utils/validation';

describe('validateDIDDocument when verificationMethod absent', () => {
  test('returns true for valid doc with no verificationMethod property', () => {
    const didDoc: any = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:1234'
    };
    expect(validateDIDDocument(didDoc)).toBe(true);
  });
});

