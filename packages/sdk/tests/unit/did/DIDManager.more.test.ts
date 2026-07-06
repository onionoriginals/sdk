import { describe, test, expect } from 'bun:test';
import { DIDManager } from '../../../src/did/DIDManager';
import { createBtcoDidDocument } from '../../../src/did/createBtcoDidDocument';

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

  test('resolveDID returns null for an unresolvable did:peer instead of a stub', async () => {
    const dm = new DIDManager({} as any);
    const doc = await dm.resolveDID('did:peer:abc');
    expect(doc).toBeNull();
  });

  test('resolveDID returns null for did:webvh when resolver fails', async () => {
    const dm = new DIDManager({} as any);
    const doc = await dm.resolveDID('did:webvh:example.com:abc');
    expect(doc).toBeNull();
  });

  test('resolveDID returns null for unsupported DID methods', async () => {
    const dm = new DIDManager({} as any);
    const doc = await dm.resolveDID('did:example:123');
    expect(doc).toBeNull();
  });

  test('migrateToDIDBTCO canonicalizes satoshi in keyless fallback (no leading zeros/whitespace)', async () => {
    // Regression: the keyless-fallback branch built the id from the raw satoshi
    // argument, so ' 42 ' / '007' produced unresolvable/non-canonical ids.
    const dm = new DIDManager({ network: 'mainnet' } as any);
    const doc = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x' }, ' 42 ');
    expect(doc.id).toBe('did:btco:42');

    const doc2 = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x' }, '007');
    expect(doc2.id).toBe('did:btco:7');
  });

  test('migrateToDIDBTCO throws BTCO_MIGRATION_KEY_DECODE_FAILED when the first VM multikey cannot be decoded (issue #318)', async () => {
    // Regression: a decode failure used to warn-and-continue, silently producing
    // a KEYLESS did:btco document — callers believed they migrated an identity
    // they control, but the resulting DID had no usable verification method.
    const dm = new DIDManager({ network: 'mainnet' } as any);
    const docWithBadKey = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:webvh:example.com:x',
      verificationMethod: [{
        id: 'did:webvh:example.com:x#keys-0',
        type: 'Multikey',
        controller: 'did:webvh:example.com:x',
        publicKeyMultibase: 'z-not-a-valid-multikey', // undecodable
      }],
    } as any;

    let thrown: unknown;
    try {
      await dm.migrateToDIDBTCO(docWithBadKey, '123');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as any).name).toBe('StructuredError');
    expect((thrown as any).code).toBe('BTCO_MIGRATION_KEY_DECODE_FAILED');
    expect((thrown as any).message).toContain('did:btco');
  });

  test('migrateToDIDBTCO throws when the first VM has no publicKeyMultibase (key cannot be carried)', async () => {
    // A VM that exists but has no multikey encoding also cannot be carried;
    // silently dropping it would be the same keyless-DID downgrade.
    const dm = new DIDManager({ network: 'mainnet' } as any);
    const docWithNonMultikeyVm = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:webvh:example.com:y',
      verificationMethod: [{
        id: 'did:webvh:example.com:y#keys-0',
        type: 'JsonWebKey2020',
        controller: 'did:webvh:example.com:y',
        // no publicKeyMultibase
      }],
    } as any;

    let thrown: unknown;
    try {
      await dm.migrateToDIDBTCO(docWithNonMultikeyVm, '123');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as any).name).toBe('StructuredError');
    expect((thrown as any).code).toBe('BTCO_MIGRATION_KEY_DECODE_FAILED');
  });

  test('migrateToDIDBTCO uses first VM when present', async () => {
    const dm = new DIDManager({ network: 'mainnet' } as any);
    const pubDoc = createBtcoDidDocument('1', 'mainnet', { publicKey: new Uint8Array(32).fill(1), keyType: 'Ed25519' });
    const vm = pubDoc.verificationMethod![0];
    const doc = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x', verificationMethod: [vm] } as any, '456');
    expect(doc.verificationMethod?.[0].publicKeyMultibase).toBeDefined();
    // Preserve service endpoints if provided
    const doc2 = await dm.migrateToDIDBTCO({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:x', verificationMethod: [vm], service: [{ id: '#s', type: 'X', serviceEndpoint: 'u' }] } as any, '789');
    expect(doc2.service?.[0].id).toBe('#s');
  });
});

