import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, createLocalSigner } from '@originals/sdk';
import { hostedAssetEnvelope, hostedResourceRefs } from './hosted-envelope';

const signer = createLocalSigner('Ed25519', new Uint8Array(32).fill(4));
const sdk = OriginalsSDK.create({ signer });
describe('CEL 3 hosted envelope', () => {
  test('reconstructs every version and keeps byte integrity independent of history signatures', async () => {
    const asset = await sdk.lifecycle.createAsset([{ id: 'image', mediaType: 'image/png', content: Uint8Array.from([137, 128, 255]) }]);
    await asset.addResourceVersion('image', Uint8Array.from([137, 128, 254]), 'image/png', { signer });
    const refs = hostedResourceRefs(asset.celLog);
    expect(refs.map((r) => r.version)).toEqual([1, 2]);
    const content = Object.fromEntries(asset.resources.map((r) => [r.digestMultibase, r.content!]));
    const rebuilt = hostedAssetEnvelope(asset.celLog, content);
    if ('problem' in rebuilt) throw new Error(rebuilt.problem.message);
    expect(rebuilt.envelope.version).toBe(3);
    const cold = await OriginalsSDK.create().lifecycle.loadAsset(JSON.parse(JSON.stringify(rebuilt.envelope)));
    expect(cold.verification.verified).toBe(true);
    expect(cold.asset.resources.map((r) => r.content)).toEqual(asset.resources.map((r) => r.content));
    const corrupted = structuredClone(rebuilt.envelope);
    corrupted.resources[1].content.data = 'AQ==';
    await expect(sdk.lifecycle.loadAsset(corrupted)).rejects.toThrow();
  });
  test('missing the latest bytes cannot restore the previous version as current', async () => {
    const asset = await sdk.lifecycle.createAsset([{ id: 'text', mediaType: 'text/plain', content: 'one' }]);
    const original = asset.resources[0];
    await asset.addResourceVersion('text', 'two', 'text/plain');
    const result = hostedAssetEnvelope(asset.celLog, { [original.digestMultibase]: original.content! });
    expect('problem' in result && result.problem.code).toBe('MISSING_CONTENT');
  });
  test('empty resources are valid while old or tampered event shapes fail', async () => {
    const asset = await sdk.lifecycle.createAsset([]);
    expect(hostedAssetEnvelope(asset.celLog, {})).toHaveProperty('envelope');
    expect(hostedAssetEnvelope({ events: [] } as never, {})).toHaveProperty('problem');
    const changed = asset.celLog;
    (changed.log[0].event.operation.data as { name: string }).name = 'forged';
    expect(hostedAssetEnvelope(changed, {})).toHaveProperty('problem');
  });
});
