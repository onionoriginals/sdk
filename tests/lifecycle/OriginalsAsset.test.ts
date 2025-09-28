import { OriginalsAsset } from '../../src/lifecycle/OriginalsAsset';
import { AssetResource, DIDDocument, VerifiableCredential, LayerType } from '../../src/types';

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
    expect(new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds).currentLayer).toBe('did:peer');
    expect(new OriginalsAsset(resources, buildDid('did:webvh:example.com:xyz'), emptyCreds).currentLayer).toBe('did:webvh');
    expect(new OriginalsAsset(resources, buildDid('did:btco:123'), emptyCreds).currentLayer).toBe('did:btco');
  });

  test('rejects invalid migration path', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:webvh:example.com:xyz'), emptyCreds);
    await expect(asset.migrate('did:peer' as LayerType)).rejects.toThrow('Invalid migration');
  });

  test('migrates along valid path and updates layer (expected to fail until implemented)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    await asset.migrate('did:webvh');
    expect(asset.currentLayer).toBe('did:webvh');
  });

  test('returns provenance chain (expected to fail until implemented)', () => {
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const prov = asset.getProvenance();
    expect(prov.createdAt).toBeDefined();
  });

  test('verifies asset integrity (inline content hash match)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(true);
  });

  test('verify returns false on invalid DID Document', async () => {
    const badDid: any = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc', controller: ['not-a-did'] };
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
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:peer:abc'), emptyCreds);
    const mockFetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as any;
    await expect(asset.verify({ fetch: mockFetch })).resolves.toBe(true);
  });

  test('verify validates attached credentials structure and returns false on bad', async () => {
    const badVc: any = { '@context': ['https://example.com'], type: ['VerifiableCredential'], issuer: 'did:peer:x', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), [badVc]);
    await expect(asset.verify()).resolves.toBe(false);
  });

  test('verify with credentialManager performs cryptographic verification', async () => {
    const goodVc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:xyz' },
      proof: { type: 'DataIntegrityProof', created: new Date().toISOString(), verificationMethod: 'did:peer:issuer#key', proofPurpose: 'assertionMethod', proofValue: 'zabc' }
    };
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), [goodVc]);
    const { CredentialManager } = await import('../../src/vc/CredentialManager');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const didManager = new DIDManager({} as any);
    const cm = new CredentialManager({ defaultKeyType: 'ES256K', network: 'regtest' } as any, didManager);
    const spy = jest.spyOn(cm, 'verifyCredential').mockResolvedValue(true);
    await expect(asset.verify({ credentialManager: cm, didManager })).resolves.toBe(true);
    spy.mockRestore();
  });

  test('verify does not fail if fetch throws when URL present', async () => {
    const resWithUrl: AssetResource = {
      id: 'r3', type: 'text', url: 'https://example.com/missing', contentType: 'text/plain', hash: resources[0].hash
    };
    const asset = new OriginalsAsset([resWithUrl], buildDid('did:peer:abc'), emptyCreds);
    const failingFetch = async () => { throw new Error('network'); };
    await expect(asset.verify({ fetch: failingFetch as any })).resolves.toBe(true);
  });

  test('constructor throws on unknown DID method (coverage for error path)', () => {
    expect(() => new OriginalsAsset(resources, buildDid('did:web:example.com'), emptyCreds)).toThrow('Unknown DID method');
  });
});


