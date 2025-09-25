import { DIDManager } from '../../src/did/DIDManager';
import { createDocumentLoader } from '../../src/vc/documentLoader';

describe('diwings documentLoader', () => {
  const didManager = new DIDManager({} as any);
  const loader = createDocumentLoader(didManager);

  test('loads v2 context', async () => {
    const res = await loader('https://www.w3.org/ns/credentials/v2');
    expect(res.document['@context']).toBeDefined();
  });

  test('resolves DID and fragment', async () => {
    const did = 'did:peer:123';
    const doc = await didManager.resolveDID(did);
    (doc as any).verificationMethod = [
      { id: `${did}#key-1`, type: 'Multikey', controller: did, publicKeyMultibase: 'z123' }
    ];
    const res = await loader(`${did}#key-1`);
    expect(res.document.id).toBe(`${did}#key-1`);
  });

  test('throws on unknown IRI', async () => {
    await expect(loader('https://unknown.example/context')).rejects.toThrow('Document not found');
  });
});

