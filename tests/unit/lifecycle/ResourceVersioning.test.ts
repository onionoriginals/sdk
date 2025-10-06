import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import { ResourceVersionManager } from '../../../src/lifecycle/ResourceVersioning';
import { AssetResource, DIDDocument, VerifiableCredential, OriginalsConfig } from '../../../src/types';
import { hashResource } from '../../../src/utils/validation';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';

function buildDid(id: string): DIDDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    verificationMethod: [{
      id: `${id}#key-0`,
      type: 'Multikey',
      controller: id,
      publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
    }]
  };
}

const emptyCreds: VerifiableCredential[] = [];

describe('ResourceVersionManager', () => {
  let versionManager: ResourceVersionManager;

  beforeEach(() => {
    versionManager = new ResourceVersionManager();
  });

  test('adds first version of a resource', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    
    const history = versionManager.getHistory('res1');
    expect(history).not.toBeNull();
    expect(history!.versions.length).toBe(1);
    expect(history!.currentVersion.version).toBe(1);
    expect(history!.currentVersion.hash).toBe('hash1');
    expect(history!.currentVersion.previousVersionHash).toBeUndefined();
  });

  test('adds second version with previous hash link', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res1', 'hash2', 'text/plain', 'hash1', 'Updated content');
    
    const history = versionManager.getHistory('res1');
    expect(history!.versions.length).toBe(2);
    expect(history!.currentVersion.version).toBe(2);
    expect(history!.currentVersion.hash).toBe('hash2');
    expect(history!.currentVersion.previousVersionHash).toBe('hash1');
    expect(history!.currentVersion.changes).toBe('Updated content');
  });

  test('getVersion retrieves specific version', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res1', 'hash2', 'text/plain', 'hash1');
    
    const v1 = versionManager.getVersion('res1', 1);
    const v2 = versionManager.getVersion('res1', 2);
    
    expect(v1!.hash).toBe('hash1');
    expect(v2!.hash).toBe('hash2');
  });

  test('getVersion returns null for invalid version', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    
    expect(versionManager.getVersion('res1', 0)).toBeNull();
    expect(versionManager.getVersion('res1', 2)).toBeNull();
    expect(versionManager.getVersion('nonexistent', 1)).toBeNull();
  });

  test('getCurrentVersion returns latest version', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res1', 'hash2', 'text/plain', 'hash1');
    versionManager.addVersion('res1', 'hash3', 'text/plain', 'hash2');
    
    const current = versionManager.getCurrentVersion('res1');
    expect(current!.version).toBe(3);
    expect(current!.hash).toBe('hash3');
  });

  test('verifyChain validates correct version chain', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res1', 'hash2', 'text/plain', 'hash1');
    versionManager.addVersion('res1', 'hash3', 'text/plain', 'hash2');
    
    expect(versionManager.verifyChain('res1')).toBe(true);
  });

  test('verifyChain fails for broken chain', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res1', 'hash2', 'text/plain', 'wronghash');
    
    expect(versionManager.verifyChain('res1')).toBe(false);
  });

  test('verifyChain fails if first version has previousVersionHash', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain', 'somehash');
    
    expect(versionManager.verifyChain('res1')).toBe(false);
  });

  test('toJSON serializes version data', () => {
    versionManager.addVersion('res1', 'hash1', 'text/plain');
    versionManager.addVersion('res2', 'hash2', 'image/png');
    
    const json = versionManager.toJSON();
    expect(json).toHaveProperty('res1');
    expect(json).toHaveProperty('res2');
  });
});

describe('OriginalsAsset - Resource Versioning', () => {
  test('creates asset with initial resource version 1', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'hello',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('hello', 'utf-8')),
        version: 1,
        createdAt: new Date().toISOString()
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    
    expect(asset.resources.length).toBe(1);
    expect(asset.resources[0].version).toBe(1);
    expect(asset.resources[0].previousVersionHash).toBeUndefined();
  });

  test('addResourceVersion creates new version and preserves old', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'hello',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('hello', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const newResource = asset.addResourceVersion('res1', 'hello world', 'text/plain', 'Added world');
    
    expect(asset.resources.length).toBe(2);
    expect(newResource.version).toBe(2);
    expect(newResource.previousVersionHash).toBe(resources[0].hash);
    expect(newResource.hash).not.toBe(resources[0].hash);
    
    // Old version should still be accessible
    const v1 = asset.getResourceVersion('res1', 1);
    expect(v1).not.toBeNull();
    expect(v1!.content).toBe('hello');
  });

  test('addResourceVersion throws error if content unchanged', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'hello',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('hello', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    
    expect(() => {
      asset.addResourceVersion('res1', 'hello', 'text/plain');
    }).toThrow('Content unchanged');
  });

  test('addResourceVersion throws error if resource not found', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'hello',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('hello', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    
    expect(() => {
      asset.addResourceVersion('nonexistent', 'content', 'text/plain');
    }).toThrow('Resource with id nonexistent not found');
  });

  test('getAllVersions returns all versions sorted', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    asset.addResourceVersion('res1', 'v2', 'text/plain');
    asset.addResourceVersion('res1', 'v3', 'text/plain');
    
    const versions = asset.getAllVersions('res1');
    expect(versions.length).toBe(3);
    expect(versions[0].version || 1).toBe(1);
    expect(versions[1].version).toBe(2);
    expect(versions[2].version).toBe(3);
  });

  test('getResourceHistory returns complete history', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    asset.addResourceVersion('res1', 'v2', 'text/plain');
    
    const history = asset.getResourceHistory('res1');
    expect(history).not.toBeNull();
    expect(history!.resourceId).toBe('res1');
    expect(history!.versions.length).toBe(2);
    expect(history!.currentVersion.version).toBe(2);
  });

  test('version chain integrity is verifiable', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    asset.addResourceVersion('res1', 'v2', 'text/plain');
    asset.addResourceVersion('res1', 'v3', 'text/plain');
    
    // Access internal version manager for testing
    const history = asset.getResourceHistory('res1');
    expect(history).not.toBeNull();
    
    // Verify chain manually
    const versions = history!.versions;
    expect(versions[0].previousVersionHash).toBeUndefined();
    expect(versions[1].previousVersionHash).toBe(versions[0].hash);
    expect(versions[2].previousVersionHash).toBe(versions[1].hash);
  });

  test('emits resource:version:created event', async () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    
    let eventEmitted = false;
    let capturedEvent: any = null;
    
    asset.on('resource:version:created', (event) => {
      eventEmitted = true;
      capturedEvent = event;
    });
    
    asset.addResourceVersion('res1', 'v2', 'text/plain', 'Test changes');
    
    // Wait for microtask to complete
    await new Promise(resolve => setImmediate(resolve));
    
    expect(eventEmitted).toBe(true);
    expect(capturedEvent.type).toBe('resource:version:created');
    expect(capturedEvent.asset.id).toBe(asset.id);
    expect(capturedEvent.resource.id).toBe('res1');
    expect(capturedEvent.resource.fromVersion).toBe(1);
    expect(capturedEvent.resource.toVersion).toBe(2);
    expect(capturedEvent.changes).toBe('Test changes');
  });

  test('provenance tracks resource updates', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const v1Hash = resources[0].hash;
    
    asset.addResourceVersion('res1', 'v2', 'text/plain', 'First update');
    asset.addResourceVersion('res1', 'v3', 'text/plain', 'Second update');
    
    const provenance = asset.getProvenance();
    expect(provenance.resourceUpdates.length).toBe(2);
    
    const update1 = provenance.resourceUpdates[0];
    expect(update1.resourceId).toBe('res1');
    expect(update1.fromVersion).toBe(1);
    expect(update1.toVersion).toBe(2);
    expect(update1.fromHash).toBe(v1Hash);
    expect(update1.changes).toBe('First update');
    
    const update2 = provenance.resourceUpdates[1];
    expect(update2.fromVersion).toBe(2);
    expect(update2.toVersion).toBe(3);
    expect(update2.changes).toBe('Second update');
  });

  test('hash-based content addressing validated', () => {
    const content1 = 'content 1';
    const content2 = 'content 2';
    const hash1 = hashResource(Buffer.from(content1, 'utf-8'));
    const hash2 = hashResource(Buffer.from(content2, 'utf-8'));
    
    expect(hash1).not.toBe(hash2);
    
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: content1,
        contentType: 'text/plain',
        hash: hash1
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const newResource = asset.addResourceVersion('res1', content2, 'text/plain');
    
    expect(newResource.hash).toBe(hash2);
    expect(newResource.hash).not.toBe(hash1);
  });

  test('versioning works with Buffer content', () => {
    const buffer1 = Buffer.from('binary content 1', 'utf-8');
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'data',
        contentType: 'application/octet-stream',
        hash: hashResource(buffer1)
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const buffer2 = Buffer.from('binary content 2', 'utf-8');
    const newResource = asset.addResourceVersion('res1', buffer2, 'application/octet-stream');
    
    expect(newResource.version).toBe(2);
    expect(newResource.hash).toBe(hashResource(buffer2));
  });

  test('versioning works across all layers (did:peer)', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    expect(asset.currentLayer).toBe('did:peer');
    
    const newResource = asset.addResourceVersion('res1', 'v2', 'text/plain');
    expect(newResource.version).toBe(2);
  });

  test('versioning works across all layers (did:webvh)', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:webvh:example.com:xyz'), emptyCreds);
    expect(asset.currentLayer).toBe('did:webvh');
    
    const newResource = asset.addResourceVersion('res1', 'v2', 'text/plain');
    expect(newResource.version).toBe(2);
  });

  test('versioning works across all layers (did:btco)', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:btco:123'), emptyCreds);
    expect(asset.currentLayer).toBe('did:btco');
    
    const newResource = asset.addResourceVersion('res1', 'v2', 'text/plain');
    expect(newResource.version).toBe(2);
  });

  test('multiple resources can be versioned independently', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'res1-v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('res1-v1', 'utf-8'))
      },
      {
        id: 'res2',
        type: 'text',
        content: 'res2-v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('res2-v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    
    asset.addResourceVersion('res1', 'res1-v2', 'text/plain');
    asset.addResourceVersion('res2', 'res2-v2', 'text/plain');
    asset.addResourceVersion('res1', 'res1-v3', 'text/plain');
    
    const res1Versions = asset.getAllVersions('res1');
    const res2Versions = asset.getAllVersions('res2');
    
    expect(res1Versions.length).toBe(3);
    expect(res2Versions.length).toBe(2);
  });

  test('timestamp is recorded for each version', () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const asset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
    const beforeTime = new Date().toISOString();
    
    const newResource = asset.addResourceVersion('res1', 'v2', 'text/plain');
    const afterTime = new Date().toISOString();
    
    expect(newResource.createdAt).toBeDefined();
    expect(newResource.createdAt! >= beforeTime).toBe(true);
    expect(newResource.createdAt! <= afterTime).toBe(true);
  });
});

describe('OriginalsAsset - Credential Integration', () => {
  test('credential can be issued for version creation (integration check)', async () => {
    const resources: AssetResource[] = [
      {
        id: 'res1',
        type: 'text',
        content: 'v1',
        contentType: 'text/plain',
        hash: hashResource(Buffer.from('v1', 'utf-8'))
      }
    ];
    
    const didDoc = buildDid('did:peer:xyz');
    const asset = new OriginalsAsset(resources, didDoc, emptyCreds);
    
    // Create credential manager
    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'ES256K'
    };
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    
    // Issue a credential for resource update
    const credential = await credentialManager.createResourceCredential(
      'ResourceUpdated',
      {
        id: 'res1',
        fromVersion: 1,
        toVersion: 2,
        timestamp: new Date().toISOString()
      },
      asset.id
    );
    
    expect(credential.type).toContain('ResourceUpdated');
    expect(credential.credentialSubject).toHaveProperty('fromVersion');
    expect(credential.credentialSubject).toHaveProperty('toVersion');
  });
});
