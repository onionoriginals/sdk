import { describe, test, expect, spyOn } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import { AssetResource, DIDDocument, VerifiableCredential, LayerType, OriginalsConfig } from '../../../src/types';
import { LifecycleManager } from '../../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';

function buildDid(id: string): DIDDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id
  };
}

const emptyCreds: VerifiableCredential[] = [];
const resources: AssetResource[] = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello',
    contentType: 'text/plain',
    hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'.slice(0, 64) // sha256('hello')
  }
];

describe('OriginalsAsset', () => {
  test('determines current layer from DID id', () => {
    // did:peer is no longer a layer (did:peer purge, Phase 4·5/5); did:cel is genesis.
    expect(new OriginalsAsset(resources, buildDid('did:cel:uEiAabc'), emptyCreds).currentLayer).toBe('did:cel');
    expect(new OriginalsAsset(resources, buildDid('did:webvh:example.com:xyz'), emptyCreds).currentLayer).toBe('did:webvh');
    expect(new OriginalsAsset(resources, buildDid('did:btco:123'), emptyCreds).currentLayer).toBe('did:btco');
  });

  test('maps a did:cel genesis to the did:cel layer', () => {
    expect(new OriginalsAsset(resources, buildDid('did:cel:uEiAabc'), emptyCreds).currentLayer).toBe('did:cel');
  });

  test('rejects invalid migration path', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:webvh:example.com:xyz'), emptyCreds);
    // Migrating to a removed/unsupported layer (did:peer) is rejected.
    // did:peer is no longer in LayerType, so cast through unknown.
    await expect(asset.migrate('did:peer' as unknown as LayerType)).rejects.toThrow('Invalid migration');
  });

  test('migrates along valid path and updates layer (expected to fail until implemented)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), emptyCreds);
    await asset.migrate('did:webvh');
    expect(asset.currentLayer).toBe('did:webvh');
  });

  test('returns provenance chain (expected to fail until implemented)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), emptyCreds);
    const prov = asset.getProvenance();
    expect(prov.createdAt).toBeDefined();
  });

  test('verifies asset integrity (inline content hash match)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(true);
  });

  test('verify returns false on invalid DID Document', async () => {
    const badDid: any = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:cel:abc', controller: ['not-a-did'] };
    const asset = new OriginalsAsset(resources, badDid, emptyCreds as any);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify uses injected fetch if provided for URL resources', async () => {
    const resWithUrl: AssetResource = {
      id: 'r2',
      type: 'text',
      url: 'https://example.com/x',
      contentType: 'text/plain',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // sha256 of empty
    };
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:cel:abc'), emptyCreds);
    const mockFetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as any;
    await expect(asset.verify({ fetch: mockFetch })).resolves.toBe(true);
  });

  test('verify rejects a URL-only resource whose hash is not entirely hex', async () => {
    // Regression: the structural hash check was unanchored (/[0-9a-f]+/i), so a
    // garbage hash like "not-a-real-hash" passed on its stray hex characters.
    // For a URL-only resource with no fetch provided, this is the only integrity
    // gate, so it must reject a non-hex hash.
    const resWithUrl: AssetResource = {
      id: 'r-badhash',
      type: 'text',
      url: 'https://example.com/x',
      contentType: 'text/plain',
      hash: 'not-a-real-hash'
    };
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:cel:abc'), emptyCreds);
    // No fetch provided → structural check is the only gate.
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify validates attached credentials structure and returns false on bad', async () => {
    const badVc: any = { '@context': ['https://example.com'], type: ['VerifiableCredential'], issuer: 'did:cel:x', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), [badVc]);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify with credentialManager performs cryptographic verification', async () => {
    const goodVc: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer: 'did:cel:issuer',
      validFrom: new Date().toISOString(),
      credentialSubject: { id: 'did:cel:xyz' },
      proof: { type: 'DataIntegrityProof', created: new Date().toISOString(), verificationMethod: 'did:cel:issuer#key', proofPurpose: 'assertionMethod', proofValue: 'zabc' }
    };
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), [goodVc]);
    const { CredentialManager } = await import('../../../src/vc/CredentialManager');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const didManager = new DIDManager({} as any);
    const cm = new CredentialManager({ defaultKeyType: 'ES256K', network: 'regtest' } as any, didManager);
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(true);
    await expect(asset.verify({ credentialManager: cm, didManager })).resolves.toBe(true);
    spy.mockRestore();
  });

  test('verify returns false when credentialManager verification fails', async () => {
    const goodVc: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer: 'did:cel:issuer',
      validFrom: new Date().toISOString(),
      credentialSubject: { id: 'did:cel:xyz' },
      proof: { type: 'DataIntegrityProof', created: new Date().toISOString(), verificationMethod: 'did:cel:issuer#key', proofPurpose: 'assertionMethod', proofValue: 'zabc' }
    };
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), [goodVc]);
    const { CredentialManager } = await import('../../../src/vc/CredentialManager');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const didManager = new DIDManager({} as any);
    const cm = new CredentialManager({ defaultKeyType: 'ES256K', network: 'regtest' } as any, didManager);
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(false);
    await expect(asset.verify({ credentialManager: cm, didManager })).resolves.toBe(false);
    spy.mockRestore();
  });

  test('verify does not fail if fetch throws when URL present', async () => {
    const resWithUrl: AssetResource = {
      id: 'r3', type: 'text', url: 'https://example.com/missing', contentType: 'text/plain', hash: resources[0].hash
    };
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:cel:abc'), emptyCreds);
    const failingFetch = async () => { throw new Error('network'); };
    await expect(asset.verify({ fetch: failingFetch as any })).resolves.toBe(true);
  });

  test('verify returns false when resource has invalid id type', async () => {
    const badResource: any = { id: 123, type: 'text', contentType: 'text/plain', hash: 'abc' };
    const asset = new OriginalsAsset([badResource], buildDid('did:cel:abc'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify returns false when resource hash has non-hex characters', async () => {
    const badResource: AssetResource = { id: 'r', type: 'text', contentType: 'text/plain', hash: 'zzzz' };
    const asset = new OriginalsAsset([badResource], buildDid('did:cel:abc'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify returns false when inline content hash mismatch', async () => {
    const badResource: AssetResource = {
      id: 'r',
      type: 'text',
      content: 'hello',
      contentType: 'text/plain',
      hash: 'wrong0000000000000000000000000000000000000000000000000000000000'
    };
    const asset = new OriginalsAsset([badResource], buildDid('did:cel:abc'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify returns false when fetched URL content hash mismatch', async () => {
    const resWithUrl: AssetResource = {
      id: 'r4',
      type: 'text',
      url: 'https://example.com/data',
      contentType: 'text/plain',
      hash: 'wrong0000000000000000000000000000000000000000000000000000000000'
    };
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:cel:abc'), emptyCreds);
    const mockFetch = async () => ({ arrayBuffer: async () => Buffer.from('test').buffer }) as any;
    await expect(asset.verify({ fetch: mockFetch })).resolves.toBe(false);
  });

  test('verify catches and returns false on unexpected error', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:cel:abc'), emptyCreds);
    // Force an error by mocking validateDIDDocument to throw
    const validateDIDDocument = require('../../../src/utils/validation').validateDIDDocument;
    spyOn(require('../../../src/utils/validation'), 'validateDIDDocument').mockImplementationOnce(() => {
      throw new Error('unexpected');
    });
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('constructor throws on unknown DID method (coverage for error path)', () => {
    expect(() => new OriginalsAsset(resources, buildDid('did:web:example.com'), emptyCreds)).toThrow('Unknown DID method');
  });
});

describe('verify() gates on whole-chain CEL verification (#Phase2 Task 8)', () => {
  // Real did:cel assets minted through the lifecycle: celLog carries genuine
  // Ed25519 controller proofs, so verifyEventLog exercises the full check.
  async function makeCelAsset() {
    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      enableLogging: false,
      storageAdapter: new MemoryStorageAdapter()
    };
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const lifecycle = new LifecycleManager(config, didManager, credentialManager, undefined, new MockKeyStore());
    return lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
  }

  test('intact celLog: verify() is true', async () => {
    const asset = await makeCelAsset();
    expect(asset.celLog).toBeDefined();
    await expect(asset.verify()).resolves.toBe(true);
  });

  test('tampered log (event data mutated post-hoc) flips verify() to false', async () => {
    const asset = await makeCelAsset();
    (asset.celLog!.events[0].data as { name?: string }).name = 'tampered';
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('a swapped-in FOREIGN log (individually valid) flips verify() to false — the _replaceCelLog binding check', async () => {
    const a = await makeCelAsset();
    const b = await makeCelAsset();
    // Sanity: B's log is valid on its own terms...
    expect((await verifyEventLog(b.celLog!)).verified).toBe(true);
    // ...but it does not back A's DID, so verify() must reject the swap.
    a._replaceCelLog(b.celLog!);
    await expect(a.verify()).resolves.toBe(false);
  });

  test('legacy asset without a celLog keeps its current verify behavior', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:cel:xyz'), emptyCreds);
    expect(asset.celLog).toBeUndefined();
    await expect(asset.verify()).resolves.toBe(true);
  });
});


