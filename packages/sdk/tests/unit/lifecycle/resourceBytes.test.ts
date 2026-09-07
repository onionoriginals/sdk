import { describe, expect, test } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { hashResource } from '../../../src/utils/validation';
import { resourcePathSegment } from '@originals/cel';

// A real PNG contains invalid UTF-8 sequences: decoding/re-encoding loses bytes.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const png = () => new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
const resource = (content: Uint8Array | string = png()) => ({
  id: 'art.png', type: 'image', contentType: 'image/png', content,
  hash: hashResource(typeof content === 'string' ? new TextEncoder().encode(content) : content)
});
function setup() {
  const storage = new MemoryStorageAdapter();
  const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', keyStore: new MockKeyStore(), storageAdapter: storage, ordinalsProvider: provider, logging: { outputs: [] } });
  return { sdk, storage, provider };
}

describe('raw resource bytes', () => {
  test('rejects binary content whose raw digest disagrees with the declared hash', async () => {
    const { sdk } = setup();
    await expect(sdk.lifecycle.createAsset([{ ...resource(), hash: 'ab'.repeat(32) }] as never)).rejects.toMatchObject({ code: 'RESOURCE_HASH_MISMATCH' });
  });

  test('owns a copy, counts actual bytes, and round-trips a canonical v2 JSON envelope', async () => {
    const { sdk } = setup();
    const input = png();
    const asset = await sdk.lifecycle.createAsset([resource(input)] as never);
    input.fill(0);
    expect(asset.resources[0].content).toEqual(png());
    expect(asset.resources[0].size).toBe(png().length);
    const env = asset.serialize();
    expect(env.version).toBe(2);
    expect(env.resources[0].content).toEqual({ encoding: 'base64', data: PNG_BASE64 });
    const { asset: loaded, verification } = await sdk.lifecycle.loadAsset(JSON.stringify(env));
    expect(verification?.verified).toBe(true);
    expect(loaded.resources[0].content).toEqual(png());
    expect(await loaded.verify()).toBe(true);
    loaded.resources[0].content![0] ^= 1;
    expect(await loaded.verify()).toBe(false);
    expect(asset.resources[0].content).toEqual(png());
  });

  test('normalizes UTF-8 convenience inputs and loads legacy v1 UTF-8 envelopes', async () => {
    const { sdk } = setup();
    const text = 'Art 🖼️';
    const asset = await sdk.lifecycle.createAsset([resource(text)]);
    expect(asset.resources[0].content).toEqual(new TextEncoder().encode(text));
    expect(asset.resources[0].hash).toBe(hashResource(new TextEncoder().encode(text)));
    const legacy = { ...asset.serialize(), version: 1 };
    legacy.resources[0].content = text;
    const loaded = await sdk.lifecycle.loadAsset(JSON.stringify(legacy));
    expect(loaded.verification?.verified).toBe(true);
    expect(loaded.asset.resources[0].content).toEqual(new TextEncoder().encode(text));
    expect(loaded.asset.serialize().version).toBe(2);
  });

  test('copies only the supplied Buffer view before the first await', async () => {
    const { sdk } = setup();
    const backing = Buffer.concat([Buffer.from([0]), Buffer.from(png()), Buffer.from([0])]);
    const view = backing.subarray(1, backing.length - 1);
    const creating = sdk.lifecycle.createAsset([resource(view)]);
    backing.fill(0);
    const asset = await creating;
    expect(asset.resources[0].content).toEqual(png());
  });

  test('rejects accidental JSON byte objects and inaccurate byte counts on input', async () => {
    const { sdk } = setup();
    for (const content of [null, [1, 2], { 0: 1 }, { type: 'Buffer', data: [1] }, new Uint16Array([1])]) {
      await expect(sdk.lifecycle.createAsset([{ ...resource(), content }] as never)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_CONTENT' });
    }
    await expect(sdk.lifecycle.createAsset([{ ...resource(), size: 1 }])).rejects.toMatchObject({ code: 'RESOURCE_SIZE_MISMATCH' });
    await expect(sdk.lifecycle.createAsset([{ ...resource(), contentBase64: PNG_BASE64 }] as never)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_CONTENT' });
  });

  test('verifies decoded bytes and rejects malformed or ambiguous encodings even when verification is skipped', async () => {
    const { sdk } = setup();
    const asset = await sdk.lifecycle.createAsset([resource()]);
    const env = asset.serialize();
    const bad = png(); bad[0] ^= 1;
    env.resources[0].content = { encoding: 'base64', data: Buffer.from(bad).toString('base64') };
    await expect(sdk.lifecycle.loadAsset(env)).rejects.toMatchObject({ code: 'ASSET_LOAD_VERIFICATION_FAILED' });
    for (const content of [PNG_BASE64, null, { 0: 137 }, { type: 'Buffer', data: [137] },
      { encoding: 'base64', data: PNG_BASE64, extra: true },
      { encoding: 'base64url', data: PNG_BASE64 },
      { encoding: 'base64', data: 'YQ' }, { encoding: 'base64', data: 'YR==' },
      { encoding: 'base64', data: ' YQ==' }, { encoding: 'base64', data: '%%==' }]) {
      env.resources[0].content = content as never;
      await expect(sdk.lifecycle.loadAsset(env, { skipVerification: true })).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
    }
    env.version = 1;
    env.resources[0].content = { encoding: 'base64', data: PNG_BASE64 };
    await expect(sdk.lifecycle.loadAsset(env, { skipVerification: true })).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
  });

  test('publishes exact PNG bytes, versions binary content, and recovers the on-sat head from a fresh SDK', async () => {
    const { sdk, storage, provider } = setup();
    const asset = await sdk.lifecycle.createAsset([resource()]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const webvh = asset.bindings!['did:webvh'].split(':');
    const userPath = webvh.slice(4).join('/');
    const keyFor = (hash: string) => `${userPath ? userPath + '/' : ''}resources/${resourcePathSegment(hash)}`;
    expect((await storage.getObject('example.com', keyFor(asset.resources[0].hash)))?.content).toEqual(png());

    const next = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNg+A8AAQIBAEK+vGgAAAAASUVORK5CYII=', 'base64'));
    const expected = new Uint8Array(next);
    const updating = asset.addResourceVersion('art.png', next, 'image/png');
    next.fill(0);
    const v2 = await updating;
    expect(v2.content).toEqual(expected);
    expect(v2.hash).toBe(hashResource(expected));
    expect(v2.size).toBe(expected.length);
    expect((await storage.getObject('example.com', keyFor(v2.hash)))?.content).toEqual(expected);
    const { asset: loaded } = await sdk.lifecycle.loadAsset(JSON.stringify(asset.serialize()));
    expect(loaded.getResourceVersion('art.png', 2)?.content).toEqual(expected);

    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    const inscriptions = await provider.getInscriptionsBySatoshi(sat);
    const inscribed = await provider.getInscriptionById(inscriptions.at(-1)!.inscriptionId);
    expect(inscribed?.content).toEqual(expected);
    expect(inscribed?.contentType).toBe('image/png');
    const fresh = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider });
    const recovered = await fresh.lifecycle.resolveAssetFromSat(sat);
    expect(recovered.verification?.verified).toBe(true);
    expect(recovered.asset.getResourceVersion('art.png', 2)?.content).toEqual(expected);
    expect(recovered.asset.getResourceVersion('art.png', 2)?.size).toBe(expected.length);
    const restored = await fresh.lifecycle.loadAsset(JSON.stringify(recovered.asset.serialize()));
    expect(restored.asset.getResourceVersion('art.png', 2)?.content).toEqual(expected);

    // A later reinscription uses the pending binary head and the existing CEL delta path.
    const third = new Uint8Array([137, 80, 78, 71, 0, 255]);
    await asset.addResourceVersion('art.png', third, 'application/octet-stream');
    const updated = await fresh.lifecycle.resolveAssetFromSat(sat);
    expect(updated.verification?.verified).toBe(true);
    expect(updated.asset.getResourceVersion('art.png', 3)?.content).toEqual(third);
  });
});
