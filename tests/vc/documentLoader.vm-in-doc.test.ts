import { createDocumentLoader } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';

describe('documentLoader finds VM inside DID Document', () => {
  test('returns the vm when present in verificationMethod array', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:ex:4',
      verificationMethod: [
        { id: 'did:ex:4#key-0', type: 'Multikey', controller: 'did:ex:4', publicKeyMultibase: 'zA' },
        { id: 'did:ex:4#key-1', type: 'Multikey', controller: 'did:ex:4', publicKeyMultibase: 'zB' }
      ]
    } as any);
    const loader = createDocumentLoader(dm);
    const res = await loader('did:ex:4#key-1');
    expect(res.document.id).toBe('did:ex:4#key-1');
    expect(res.document.publicKeyMultibase).toBe('zB');
  });
});

