/**
 * Item 5: the documented atomicRollback option (LifecycleOperationOptions,
 * "default: true") was never read by any code. publishToWeb left
 * already-written resources (and mutated resource.url fields) behind when a
 * later step failed. It is now implemented for the publish path: on failure,
 * resource.url mutations are reverted and written objects are best-effort
 * deleted when the adapter supports deletion.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import type { AssetResource } from '../../../src/types';

// Fresh objects per test: createAsset holds references to the resource
// objects it is given, so sharing one module-level array would leak url
// mutations between tests.
function makeResources(): AssetResource[] {
  return [
    { id: 'r1', type: 'text', contentType: 'text/plain', hash: '1974d92bd968cd5723d7eafd3c5ed66642777c6119fbf81ef42e0cb6af6bc405', content: 'first resource' },
    { id: 'r2', type: 'text', contentType: 'text/plain', hash: 'a7562edd17428eec751400f3389675e0195f7fb31cd54730cd6cafa8cc26566c', content: 'second resource' }
  ];
}

/**
 * Adapter that fails on the Nth putObject call. Call #1 is createAsset's
 * best-effort genesis persist (cel/<suffix>.json, Phase 3), so the first
 * RESOURCE write during publish is call #2.
 */
function makeFailingAdapter(failOnCall: number) {
  const objects = new Map<string, string>();
  const deleted: string[] = [];
  let calls = 0;
  return {
    objects,
    deleted,
    adapter: {
      async putObject(domain: string, path: string, content: Uint8Array | string): Promise<string> {
        calls++;
        if (calls === failOnCall) {
          throw new Error('storage write exploded');
        }
        objects.set(`${domain}/${path}`, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
        return `mem://${domain}/${path}`;
      },
      async getObject(): Promise<null> {
        return null;
      },
      async exists(): Promise<boolean> {
        return false;
      },
      async deleteObject(domain: string, path: string): Promise<void> {
        deleted.push(`${domain}/${path}`);
        objects.delete(`${domain}/${path}`);
      }
    }
  };
}

describe('publishToWeb atomicRollback', () => {
  test('default (atomicRollback on): a mid-publish failure reverts resource.url mutations and stays on did:peer', async () => {
    // Fail on the SECOND resource write (call 1 = genesis cel persist).
    const { adapter, deleted } = makeFailingAdapter(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', storageAdapter: adapter as any });
    const asset = await sdk.lifecycle.createAsset(makeResources());

    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com')).rejects.toThrow('storage write exploded');

    // The first resource HAD been written and its url set before the second
    // write failed; atomic rollback must revert the mutation.
    for (const resource of asset.resources) {
      expect((resource as { url?: string }).url).toBeUndefined();
    }
    expect(asset.currentLayer).toBe('did:peer');
    // The successfully-written first object was best-effort deleted
    // (the adapter supports deleteObject).
    expect(deleted.length).toBe(1);
  });

  test('atomicRollback: false preserves partial writes for inspection', async () => {
    // Fail on the SECOND resource write (call 1 = genesis cel persist).
    const { adapter, deleted } = makeFailingAdapter(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', storageAdapter: adapter as any });
    const asset = await sdk.lifecycle.createAsset(makeResources());

    await expect(
      sdk.lifecycle.publishToWeb(asset, 'example.com', { atomicRollback: false })
    ).rejects.toThrow('storage write exploded');

    // With rollback disabled, the first resource keeps its published url.
    const urls = asset.resources.map((r) => (r as { url?: string }).url);
    expect(urls.filter((u) => u !== undefined).length).toBe(1);
    expect(deleted.length).toBe(0);
  });

  test('rollback works without adapter delete support (urls reverted, orphans tolerated)', async () => {
    const objects = new Map<string, string>();
    let calls = 0;
    const adapter = {
      async putObject(domain: string, path: string, content: Uint8Array | string): Promise<string> {
        calls++;
        // Second resource write (call 1 = createAsset's genesis cel persist).
        if (calls === 3) throw new Error('storage write exploded');
        objects.set(`${domain}/${path}`, String(content));
        return `mem://${domain}/${path}`;
      },
      async getObject(): Promise<null> {
        return null;
      },
      async exists(): Promise<boolean> {
        return false;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', storageAdapter: adapter as any });
    const asset = await sdk.lifecycle.createAsset(makeResources());

    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com')).rejects.toThrow('storage write exploded');
    for (const resource of asset.resources) {
      expect((resource as { url?: string }).url).toBeUndefined();
    }
    expect(asset.currentLayer).toBe('did:peer');
  });

  test('a successful publish is unaffected by the rollback machinery', async () => {
    const { adapter } = makeFailingAdapter(999);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = OriginalsSDK.create({ network: 'regtest', storageAdapter: adapter as any });
    const asset = await sdk.lifecycle.createAsset(makeResources());

    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');
    for (const resource of published.resources) {
      expect((resource as { url?: string }).url).toBeDefined();
    }
  });
});
