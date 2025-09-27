import { registerVerificationMethod, verificationMethodRegistry } from '../../src/vc/documentLoader';

describe('registerVerificationMethod with missing id', () => {
  test('does nothing when vm.id is absent', () => {
    const before = verificationMethodRegistry.size;
    registerVerificationMethod({ controller: 'did:ex' } as any);
    const after = verificationMethodRegistry.size;
    expect(after).toBe(before);
  });
});

