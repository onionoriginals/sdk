/**
 * Fee preview + confirm for did:btco appends (#407 phase 4). estimateAppendCost
 * previews the unavoidable inscription cost without committing; an inscribeConfirm
 * gate lets a caller approve or CLEANLY ABORT a paid append after seeing the
 * estimate. A declined append is a byte-identical no-op — no event, nothing
 * inscribed, a follow-up append still works.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { KeyManager } from '../../src/did/KeyManager';
import { hashResource } from '../../src/utils/validation';
import type { AppendCostEstimate } from '../../src/types';

const contentHash = (s: string) => hashResource(Buffer.from(s, 'utf8'));

function makeSDK(extra: Record<string, unknown> = {}) {
  const ordinalsProvider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore(),
    ...extra
  });
  return { sdk, ordinalsProvider };
}

const inssOnSat = (p: OrdMockProvider, sat: string) =>
  (p as any)['state'].inscriptionsBySatoshi.get(sat) as string[] | undefined;

async function btcoAsset(sdk: OriginalsSDK, seed = 'v1') {
  const asset = await sdk.lifecycle.createAsset([
    { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash(seed), content: seed }
  ]);
  await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
  const sat = asset.bindings!['did:btco'].split(':').pop()!;
  return { asset, sat };
}

describe('fee preview + confirm (#407 phase 4)', () => {
  test('estimateAppendCost previews a plausible quote and mutates NOTHING', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const { asset, sat } = await btcoAsset(sdk);

    const eventsBefore = asset.celLog!.events.length;
    const resourcesBefore = asset.resources.length;
    const inssBefore = inssOnSat(ordinalsProvider, sat)!.length;
    const logHeadBefore = JSON.stringify(asset.celLog!.events);

    const estimate = await sdk.lifecycle.estimateAppendCost(asset, 'update', { content: 'v2-media' });
    expect(estimate.satoshis).toBeGreaterThan(0);
    expect(estimate.feeRate).toBeGreaterThan(0);
    expect(estimate.vbytes).toBeGreaterThan(0);
    expect(estimate.contentBytes).toBe(Buffer.from('v2-media', 'utf8').byteLength);
    // satoshis = feeRate × vbytes, vbytes = ceil(contentBytes/4)+200.
    expect(estimate.vbytes).toBe(Math.ceil(estimate.contentBytes / 4) + 200);
    expect(estimate.satoshis).toBe(Math.ceil(estimate.feeRate * estimate.vbytes));

    // Zero side effects: log, resources, and the chain are untouched.
    expect(asset.celLog!.events.length).toBe(eventsBefore);
    expect(asset.resources.length).toBe(resourcesBefore);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(inssBefore);
    expect(JSON.stringify(asset.celLog!.events)).toBe(logHeadBefore);
  });

  test('estimateAppendCost without an ordinalsProvider throws ORD_PROVIDER_REQUIRED', async () => {
    // Build a btco asset WITH a provider, then quote via a provider-less SDK.
    const { sdk } = makeSDK();
    const { asset } = await btcoAsset(sdk);
    const noProvider = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    await expect(noProvider.lifecycle.estimateAppendCost(asset, 'update', { content: 'x' }))
      .rejects.toMatchObject({ code: 'ORD_PROVIDER_REQUIRED' });
  });

  test('the preview quote ≈ the actual cost the real append incurs (same fee source)', async () => {
    const { sdk } = makeSDK();
    const { asset } = await btcoAsset(sdk);

    const preview = await sdk.lifecycle.estimateAppendCost(asset, 'update', { content: 'v2' });
    let cost: { feeRate?: number; estVsize: number; estSats?: number } | undefined;
    sdk.lifecycle.on('cel:inscribe-cost', (e: any) => { cost = e; });

    await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2');
    expect(cost).toBeDefined();
    expect(cost!.feeRate).toBe(preview.feeRate);
    expect(cost!.estVsize).toBe(preview.vbytes);
    expect(cost!.estSats).toBe(preview.satoshis);
  });

  test('inscribeConfirm callback → true proceeds and inscribes (phase-3 path)', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const { asset, sat } = await btcoAsset(sdk);
    const before = inssOnSat(ordinalsProvider, sat)!.length;

    let seen: AppendCostEstimate | undefined;
    await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2', {
      inscribeConfirm: (est) => { seen = est; return true; }
    });

    expect(seen).toBeDefined();
    expect(seen!.contentBytes).toBe(Buffer.from('v2', 'utf8').byteLength);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(before + 1);
    expect(asset.resources.find(r => r.hash === contentHash('v2'))?.content).toBe('v2');
  });

  test('inscribeConfirm → false ABORTS cleanly: no event, nothing inscribed, byte-identical; a follow-up still works', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const { asset, sat } = await btcoAsset(sdk);

    const eventsBefore = asset.celLog!.events.length;
    const resourcesBefore = asset.resources.length;
    const inssBefore = inssOnSat(ordinalsProvider, sat)!.length;
    const logBefore = JSON.stringify(asset.celLog!.events);

    let declined: any;
    sdk.lifecycle.on('cel:inscribe-declined', (e: any) => { declined = e; });

    await expect(
      asset.addResourceVersion('art', 'v2', 'image/png', 'to v2', { inscribeConfirm: () => false })
    ).rejects.toMatchObject({ code: 'PROVENANCE_APPEND_DECLINED' });

    // Byte-identical: no event appended, nothing inscribed, no new resource version.
    expect(asset.celLog!.events.length).toBe(eventsBefore);
    expect(asset.resources.length).toBe(resourcesBefore);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(inssBefore);
    expect(JSON.stringify(asset.celLog!.events)).toBe(logBefore);
    expect(asset.resources.find(r => r.hash === contentHash('v2'))).toBeUndefined();
    // The declined event carries the estimate the caller rejected.
    expect(declined).toBeDefined();
    expect(declined.appendKind).toBe('update');
    expect(declined.estimate.satoshis).toBeGreaterThan(0);

    // No poisoned state: a subsequent append proceeds and inscribes normally.
    await asset.addResourceVersion('art', 'v2b', 'image/png', 'to v2b');
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(inssBefore + 1);
    expect(asset.resources.find(r => r.hash === contentHash('v2b'))?.content).toBe('v2b');
  });

  test('config-level inscribeConfirm default gates all btco appends unless overridden', async () => {
    let calls = 0;
    const { sdk, ordinalsProvider } = makeSDK({ inscribeConfirm: () => { calls++; return false; } });
    const { asset, sat } = await btcoAsset(sdk);
    const before = inssOnSat(ordinalsProvider, sat)!.length;

    // Config default declines.
    await expect(asset.addResourceVersion('art', 'v2', 'image/png', 'to v2'))
      .rejects.toMatchObject({ code: 'PROVENANCE_APPEND_DECLINED' });
    expect(calls).toBe(1);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(before);

    // Per-call override wins over the config default.
    await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2', { inscribeConfirm: 'now' });
    expect(calls).toBe(1); // config callback not consulted for the overridden call
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(before + 1);
  });

  test("default (no inscribeConfirm) preserves phase-3 behavior — append inscribes, no prompt", async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const { asset, sat } = await btcoAsset(sdk);
    const before = inssOnSat(ordinalsProvider, sat)!.length;
    await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2');
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(before + 1);
  });

  test("rotate estimate sizes the PAID content (head media), matching reinscribeRotatedDoc — not the DID doc", async () => {
    const { sdk } = makeSDK();
    // Media large enough that DID-doc size and media size are unambiguously different.
    const media = 'M'.repeat(4096);
    const { asset } = await btcoAsset(sdk, media);

    const est = await sdk.lifecycle.estimateAppendCost(asset, 'rotate');
    // reinscribeRotatedDoc inscribes headMedia.content as CONTENT (doc rides in
    // metadata), so the paid content size IS the head media — not the DID doc.
    expect(est.contentBytes).toBe(Buffer.from(media, 'utf8').byteLength);
  });

  test('rotateBtcoKeys is gated: decline aborts cleanly; a subsequent rotation with true inscribes', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const { asset, sat } = await btcoAsset(sdk);
    const eventsBefore = asset.celLog!.events.length;
    const inssBefore = inssOnSat(ordinalsProvider, sat)!.length;

    let declined: any;
    sdk.lifecycle.on('cel:inscribe-declined', (e: any) => { declined = e; });

    const k1 = await new KeyManager().generateKeyPair('Ed25519');
    await expect(
      sdk.lifecycle.rotateBtcoKeys(
        asset,
        { publicKeyMultibase: k1.publicKey, privateKey: k1.privateKey },
        5,
        { inscribeConfirm: () => false }
      )
    ).rejects.toMatchObject({ code: 'PROVENANCE_APPEND_DECLINED' });

    // Byte-identical: no rotateKey event appended, no reinscription.
    expect(asset.celLog!.events.length).toBe(eventsBefore);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(inssBefore);
    expect(declined?.appendKind).toBe('rotate');

    // A subsequent rotation proceeds (concurrency claim was released on abort).
    const k2 = await new KeyManager().generateKeyPair('Ed25519');
    const res = await sdk.lifecycle.rotateBtcoKeys(
      asset,
      { publicKeyMultibase: k2.publicKey, privateKey: k2.privateKey },
      5,
      { inscribeConfirm: () => true }
    );
    expect(res.inscriptionId).toBeDefined();
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(inssBefore + 1);
  });

  test('off-btco append IGNORES the gate (no inscription, callback never consulted)', async () => {
    const { sdk } = makeSDK();
    // Stay on did:webvh — not the final layer, no inscription, so no cost to consent to.
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('v1'), content: 'v1' }
    ]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');

    let consulted = false;
    const res = await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2', {
      inscribeConfirm: () => { consulted = true; return false; }
    });
    expect(consulted).toBe(false);
    expect(res.content).toBe('v2');
    expect(asset.resources.find(r => r.hash === contentHash('v2'))?.content).toBe('v2');
  });
});
