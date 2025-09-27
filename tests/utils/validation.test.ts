import { validateDID, validateCredential, validateDIDDocument, hashResource } from '../../src/utils/validation';

describe('validation utils', () => {
  test('validateDID supports peer, webvh, btco', () => {
    expect(validateDID('did:peer:123')).toBe(true);
    expect(validateDID('did:webvh:example.com:abc')).toBe(true);
    expect(validateDID('did:btco:123')).toBe(true);
    expect(validateDID('did:web:example.com')).toBe(false);
    expect(validateDID('invalid')).toBe(false);
    // Cover defensive branch: regex.test returns true but match returns null
    const testSpy = jest.spyOn(RegExp.prototype, 'test').mockReturnValueOnce(true);
    const matchSpy = jest.spyOn(String.prototype, 'match').mockReturnValueOnce(null as any);
    expect(validateDID('did:peer:abc')).toBe(false);
    testSpy.mockRestore();
    matchSpy.mockRestore();
  });

  test('validateCredential basic VC shape', () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'Test'],
      issuer: 'did:peer:abc',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:abc', foo: 'bar' }
    };
    expect(validateCredential(vc)).toBe(true);
  });

  test('validateCredential negative cases', () => {
    expect(validateCredential({} as any)).toBe(false);
    // Fails on missing type array
    expect(validateCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: undefined, issuer: 'did:peer:x', issuanceDate: new Date().toISOString(), credentialSubject: {} } as any)).toBe(false);
    // Fails on missing VerifiableCredential type
    expect(validateCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['Other'], issuer: 'did:peer:x', issuanceDate: new Date().toISOString(), credentialSubject: {} } as any)).toBe(false);
    // Fails on missing issuanceDate
    expect(validateCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:x', credentialSubject: {} } as any)).toBe(false);
    // Fails on missing credentialSubject
    expect(validateCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:x', issuanceDate: new Date().toISOString() } as any)).toBe(false);
  });

  test('validateDIDDocument shape', () => {
    const didDoc: any = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:abc',
      verificationMethod: [
        { id: '#key-1', type: 'Ed25519VerificationKey2020', controller: 'did:peer:abc', publicKeyMultibase: 'z...' }
      ]
    };
    expect(validateDIDDocument(didDoc)).toBe(true);
  });

  test('validateDIDDocument negative cases', () => {
    expect(validateDIDDocument({} as any)).toBe(false);
    expect(validateDIDDocument({ '@context': [], id: 'invalid' } as any)).toBe(false);
    const badVm: any = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:abc',
      verificationMethod: [{ id: '#1', type: 'X', controller: '', publicKeyMultibase: '' }, { id: null }]
    };
    expect(validateDIDDocument(badVm)).toBe(false);
  });

  test('hashResource returns sha256 hex', () => {
    const hash = hashResource(Buffer.from('hello'));
    expect(hash).toHaveLength(64);
    expect(/[0-9a-f]{64}/.test(hash)).toBe(true);
  });
});

/** Inlined from validation.no-vm.part.ts */
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
