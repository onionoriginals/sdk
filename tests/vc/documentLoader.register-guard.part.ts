import { registerVerificationMethod, verificationMethodRegistry } from '../../src/vc/documentLoader';

describe('documentLoader registerVerificationMethod guard', () => {
  test('does not register when vm.id is missing', () => {
    const sizeBefore = verificationMethodRegistry.size;
    registerVerificationMethod({} as any);
    expect(verificationMethodRegistry.size).toBe(sizeBefore);
  });
});