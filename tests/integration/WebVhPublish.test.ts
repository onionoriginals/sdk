/** Canonical test aggregator created by combine-tests script. */

/** Inlined from WebVhPublish.integration.part.ts */
import { OriginalsSDK } from '../../src';
import { AssetResource } from '../../src/types';

describe('WebVH publish end-to-end', () => {
  const sdk = OriginalsSDK.create({ network: 'regtest' });
  const domain = 'example.com';

  test('createAsset → publishToWeb yields did:webvh and provenance event', async () => {
    const resources: AssetResource[] = [
      { id: 'r1', type: 'data', contentType: 'text/plain', hash: 'abc123', content: 'hello' }
    ];

    const asset = await sdk.lifecycle.createAsset(resources);
    const published = await sdk.lifecycle.publishToWeb(asset, domain);
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.id.startsWith('did:peer:')).toBe(true);
    const webBinding = (published as any).bindings?.['did:webvh'];
    expect(typeof webBinding).toBe('string');
    expect(webBinding!.startsWith(`did:webvh:${domain}:`)).toBe(true);

    const resolved = await sdk.did.resolveDID(webBinding!);
    expect(resolved?.id).toBe(webBinding);
  });
});
