import { createDocumentLoader, registerVerificationMethod } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';

describe('documentLoader branches', () => {
  test('throws when DID not resolved', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce(null as any);
    const loader = createDocumentLoader(dm);
    await expect(loader('did:ex:404')).rejects.toThrow('DID not resolved');
  });

  test('returns cached verification method for fragment', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex:1' } as any);
    const loader = createDocumentLoader(dm);
    registerVerificationMethod({ id: 'did:ex:1#key-1', type: 'Multikey', controller: 'did:ex:1', publicKeyMultibase: 'zAb' });
    const res = await loader('did:ex:1#key-1');
    expect(res.document.id).toBe('did:ex:1#key-1');
    expect(res.document.publicKeyMultibase).toBe('zAb');
  });

  test('loads base DID without fragment', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex:2' } as any);
    const loader = createDocumentLoader(dm);
    const res = await loader('did:ex:2');
    expect(res.document.id).toBe('did:ex:2');
  });
});

