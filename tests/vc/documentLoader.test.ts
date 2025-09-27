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

/** Inlined from documentLoader.branches.part.ts */
import { createDocumentLoader, registerVerificationMethod } from '../../src/vc/documentLoader';

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




/** Inlined from documentLoader.branches2.part.ts */

describe('documentLoader missing VM branch', () => {
  test('returns stub VM when fragment not found in DID document', async () => {
    const dm = new DIDManager({} as any);
    jest.spyOn(dm, 'resolveDID').mockResolvedValueOnce({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex:stub', verificationMethod: [] } as any);
    const loader = createDocumentLoader(dm);
    const res = await loader('did:ex:stub#not-present');
    expect(res.document.id).toBe('did:ex:stub#not-present');
  });
});




/** Inlined from documentLoader.register-guard.part.ts */
import { registerVerificationMethod, verificationMethodRegistry } from '../../src/vc/documentLoader';

describe('documentLoader registerVerificationMethod guard', () => {
  test('does not register when vm.id is missing', () => {
    const sizeBefore = verificationMethodRegistry.size;
    registerVerificationMethod({} as any);
    expect(verificationMethodRegistry.size).toBe(sizeBefore);
  });
});


/** Inlined from documentLoader.register-missing-id.part.ts */

describe('registerVerificationMethod with missing id', () => {
  test('does nothing when vm.id is absent', () => {
    const before = verificationMethodRegistry.size;
    registerVerificationMethod({ controller: 'did:ex' } as any);
    const after = verificationMethodRegistry.size;
    expect(after).toBe(before);
  });
});




/** Inlined from documentLoader.vm-in-doc.part.ts */

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
