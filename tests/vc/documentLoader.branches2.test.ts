import { createDocumentLoader } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';

describe('documentLoader missing VM branch', () => {
  test('returns stub VM when fragment not found in DID document', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex:stub', verificationMethod: [] } as any);
    const loader = createDocumentLoader(dm);
    const res = await loader('did:ex:stub#not-present');
    expect(res.document.id).toBe('did:ex:stub#not-present');
  });
});

