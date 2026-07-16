/**
 * Tests: publishToWeb validates domain format (issue #207)
 *
 * Verifies that LifecycleManager.publishToWeb rejects malformed domain strings
 * before any resource publishing occurs, matching the validation already
 * present in batchPublishToWeb.
 */
import { describe, it, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

const resources = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  },
];

async function createDraftAsset() {
  const sdk = OriginalsSDK.create({ storageAdapter: new MemoryStorageAdapter(), network: 'regtest', enableLogging: false });
  return { sdk, asset: await sdk.lifecycle.createAsset(resources) };
}

describe('LifecycleManager.publishToWeb — domain format validation', () => {
  it('rejects a clearly malformed domain (bare label, no TLD)', async () => {
    const { sdk, asset } = await createDraftAsset();
    await expect(sdk.lifecycle.publishToWeb(asset, 'notadomain')).rejects.toThrow('Invalid domain format');
  });

  it('rejects a domain with spaces', async () => {
    const { sdk, asset } = await createDraftAsset();
    await expect(sdk.lifecycle.publishToWeb(asset, 'invalid domain.com')).rejects.toThrow('Invalid domain format');
  });

  it('rejects a domain with an invalid port', async () => {
    const { sdk, asset } = await createDraftAsset();
    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com:99999')).rejects.toThrow('Invalid domain format');
  });

  it('rejects a domain with a non-numeric port', async () => {
    const { sdk, asset } = await createDraftAsset();
    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com:abc')).rejects.toThrow('Invalid domain format');
  });

  it('rejects a domain with a trailing colon (empty port)', async () => {
    const { sdk, asset } = await createDraftAsset();
    // Macroscope #211: 'example.com:' splits to portPart='' which is falsy;
    // an empty port must be rejected, not skipped.
    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com:')).rejects.toThrow('Invalid domain format');
  });

  it('rejects a domain with more than one colon (extra segments not silently dropped)', async () => {
    const { sdk, asset } = await createDraftAsset();
    // Greptile #211: split(':') previously discarded everything after the port,
    // so example.com:8080:path passed validation then got encoded verbatim.
    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com:8080:path')).rejects.toThrow('Invalid domain format');
  });

  it('normalizes domain (trim + lowercase) before building the DID', async () => {
    const { sdk, asset } = await createDraftAsset();
    // Macroscope #211: validation normalized but the original string was encoded,
    // so whitespace/mixed-case produced a DID that didn't match the normalized form.
    const published = await sdk.lifecycle.publishToWeb(asset, '  Example.COM  ');
    expect(published.currentLayer).toBe('did:webvh');
    const webvh = published.bindings?.['did:webvh'] ?? '';
    expect(webvh).toContain('example.com');
    expect(webvh).not.toContain('Example.COM');
    expect(webvh).not.toContain('%20'); // no encoded leading/trailing whitespace
  });

  it('accepts a valid domain (example.com)', async () => {
    const { sdk, asset } = await createDraftAsset();
    // Should not throw on domain validation (may fail later in resource publish, which is OK)
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.bindings?.['did:webvh']).toContain('example.com');
  });

  it('accepts localhost (development domain)', async () => {
    const { sdk, asset } = await createDraftAsset();
    const published = await sdk.lifecycle.publishToWeb(asset, 'localhost');
    expect(published.currentLayer).toBe('did:webvh');
  });

  it('accepts localhost with a valid port', async () => {
    const { sdk, asset } = await createDraftAsset();
    const published = await sdk.lifecycle.publishToWeb(asset, 'localhost:5000');
    expect(published.currentLayer).toBe('did:webvh');
  });

  it('bypasses domain validation when a full did:webvh DID is supplied', async () => {
    const { sdk, asset } = await createDraftAsset();
    // Supplying a full did:webvh DID bypasses domain extraction/validation entirely
    const published = await sdk.lifecycle.publishToWeb(asset, 'did:webvh:example.com:user');
    expect(published.currentLayer).toBe('did:webvh');
  });
});
