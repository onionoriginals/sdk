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
    type: 'image',
    contentType: 'image/png',
    hash: 'abc123'
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

  test('verifies asset integrity (expected to fail until implemented)', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    await expect(asset.verify()).resolves.toBe(true);
  });

  test('constructor throws on unknown DID method (coverage for error path)', () => {
    expect(() => new OriginalsAsset(resources, buildDid('did:web:example.com'), emptyCreds)).toThrow('Unknown DID method');
  });
});


