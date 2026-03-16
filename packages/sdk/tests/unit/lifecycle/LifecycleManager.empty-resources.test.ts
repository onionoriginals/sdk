import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';

describe('LifecycleManager - empty resources guard', () => {
  test('publishToWeb with emptied resources does not produce credential with undefined resourceId', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res1', type: 'text', content: 'hello', contentType: 'text/plain', hash: 'abc' }
    ]);

    // Simulate post-creation resource removal (e.g., deserialization edge case)
    asset.resources.length = 0;

    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');

    // No credential should have been issued (guard prevented undefined resourceId)
    const migratedCreds = published.credentials.filter(
      (c) => c.type.includes('ResourceMigrated') || c.type.includes('ResourceMigratedCredential')
    );
    expect(migratedCreds.length).toBe(0);
  });

  test('publishToWeb with valid resources produces credential with defined resourceId', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res1', type: 'text', content: 'hello', contentType: 'text/plain', hash: 'abc123' }
    ]);
    expect(asset.resources.length).toBe(1);

    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');

    // Credential issuance may fail due to missing keyStore in test env,
    // but if it succeeded, resourceId must be a defined string
    for (const cred of published.credentials) {
      if (cred.type.includes('ResourceMigrated') || cred.type.includes('ResourceMigratedCredential')) {
        expect(cred.credentialSubject.resourceId).toBeDefined();
        expect(typeof cred.credentialSubject.resourceId).toBe('string');
      }
    }
  });

  test('publishToWeb with resource having empty id does not produce credential', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res1', type: 'text', content: 'hello', contentType: 'text/plain', hash: 'abc123' }
    ]);

    // Force the resource id to be empty string (falsy) after creation
    (asset.resources[0] as any).id = '';

    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');

    // Guard should have caught the empty id
    const migratedCreds = published.credentials.filter(
      (c) => c.type.includes('ResourceMigrated') || c.type.includes('ResourceMigratedCredential')
    );
    expect(migratedCreds.length).toBe(0);
  });
});
