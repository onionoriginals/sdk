import { DIDManager } from '../../src/did/DIDManager';
import { createBtcoDidDocument } from '../../src/did/createBtcoDidDocument';

describe('DIDManager additional branches', () => {
  test('migrateToDIDWebVH rejects invalid domain', async () => {
    const dm = new DIDManager({} as any);
    await expect(dm.migrateToDIDWebVH({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:x' }, 'bad..host')).rejects.toThrow('Invalid domain');
  });

  test('migrateToDIDBTCO validates satoshi and carries services', async () => {
    const dm = new DIDManager({ network: 'mainnet' } as any);
    await expect(dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x', service: [{ id: '#s', type: 'X', serviceEndpoint: 'u' }] }, 'x')).rejects.toThrow('Invalid satoshi identifier');

    const doc = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x', service: [{ id: '#s', type: 'X', serviceEndpoint: 'u' }] }, '123');
    expect(doc.id).toBe('did:btco:123');
    expect(doc.service?.length).toBe(1);
  });

  test('resolveDID returns passthrough doc for non-webvh, non-btco methods', async () => {
    const dm = new DIDManager({} as any);
    const doc = await dm.resolveDID('did:peer:abc');
    expect(doc?.id).toBe('did:peer:abc');
  });

  test('resolveDID returns minimal doc for did:webvh when resolver fails', async () => {
    const dm = new DIDManager({} as any);
    const doc = await dm.resolveDID('did:webvh:example.com:abc');
    expect(doc?.id).toBe('did:webvh:example.com:abc');
  });

  test('migrateToDIDBTCO uses first VM when present', async () => {
    const dm = new DIDManager({ network: 'mainnet' } as any);
    const pubDoc = createBtcoDidDocument('1', 'mainnet', { publicKey: new Uint8Array(32).fill(1), keyType: 'Ed25519' });
    const vm = pubDoc.verificationMethod![0];
    const doc = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x', verificationMethod: [vm] } as any, '456');
    expect(doc.verificationMethod?.[0].publicKeyMultibase).toBeDefined();
  });
});

