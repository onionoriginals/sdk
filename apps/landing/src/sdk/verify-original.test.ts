import { describe, test, expect, afterEach } from 'bun:test';
import { verifyHistory } from '@originals/sdk/cel';
import type { AssetResolution } from '@originals/sdk';
import { verifyOriginal } from './verify-original';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';

describe('native hosted verification', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());
  async function fixture() {
    host = installCel3Host();
    const { engine } = engineWithSigner();
    await engine.create('Original', 'Text', { filename: 'file.txt', content: 'exact bytes', contentType: 'text/plain' });
    const state = await engine.publish();
    return { did: state.webvhDid!, logEntries: (await (await fetch(state.webvhLogUrl!)).text()).trim().split('\n').map((s) => JSON.parse(s)), celLog: engine.asset!.celLog, resourceBytes: new TextEncoder().encode('exact bytes'), declaredHash: state.resource.hash };
  }
  test('validates content, method history and controller history with their bidirectional binding', async () => {
    const input = await fixture();
    expect((await verifyOriginal(input)).every((c) => c.ok)).toBe(true);
  });
  test('rejects tampering or an unrelated DID without confusing the byte check', async () => {
    const input = await fixture();
    const changed = structuredClone(input);
    (changed.celLog.log[0].event.operation.data as { name: string }).name = 'forged';
    expect((await verifyOriginal(changed)).find((c) => c.id === 'cel')!.ok).toBe(false);
    const wrong = { ...input, did: input.did.replace('demo.test', 'other.test') };
    expect((await verifyOriginal(wrong)).filter((c) => c.id !== 'hash').every((c) => !c.ok)).toBe(true);
    expect((await verifyOriginal({ ...input, resourceBytes: new Uint8Array([1]) })).find((c) => c.id === 'hash')!.ok).toBe(false);
  });
  test('omits the btco check entirely for a webvh-only publication (no sat)', async () => {
    const input = await fixture();
    const checks = await verifyOriginal(input);
    expect(checks.find((c) => c.id === 'btco')).toBeUndefined();
  });
  function acceptedResolution(assetId: string, controller: string): AssetResolution {
    return {
      status: 'accepted',
      asset: { id: assetId },
      verification: {},
      resolution: {
        state: { controller, active: true },
        publications: [{ inscriptionId: 'reveal' + 'a'.repeat(60) + 'i0' }],
        chainEvidence: { assurance: 'node-validated' },
      },
      didDocument: null,
      resourceAvailability: [],
    } as unknown as AssetResolution;
  }
  test('a btco check bound to THIS asset id and controller passes; an accepted-but-unrelated sat fails', async () => {
    const input = await fixture();
    const { state } = verifyHistory(input.celLog);
    const bound = await verifyOriginal({
      ...input,
      sat: '1250000000',
      btcoResolution: acceptedResolution(state.assetId, state.controller),
    });
    expect(bound.find((c) => c.id === 'btco')!.ok).toBe(true);
    expect(bound.every((c) => c.ok)).toBe(true);
    const wrongAsset = await verifyOriginal({
      ...input,
      sat: '1250000000',
      btcoResolution: acceptedResolution('ni:///sha-256;unrelated', state.controller),
    });
    expect(wrongAsset.find((c) => c.id === 'btco')!.ok).toBe(false);
    const wrongController = await verifyOriginal({
      ...input,
      sat: '1250000000',
      btcoResolution: acceptedResolution(state.assetId, 'did:key:zUnrelatedController'),
    });
    expect(wrongController.find((c) => c.id === 'btco')!.ok).toBe(false);
  });
  test('a deactivated on-chain history cannot verify an active hosted Original', async () => {
    const input = await fixture();
    const { state } = verifyHistory(input.celLog);
    const resolution = acceptedResolution(state.assetId, state.controller);
    if (resolution.status === 'accepted') resolution.resolution.state.active = false;
    const checks = await verifyOriginal({ ...input, sat: '1250000000', btcoResolution: resolution });
    expect(checks.find((c) => c.id === 'btco')!.ok).toBe(false);
  });
  test('a non-accepted or missing resolution fails the btco check rather than being silently skipped', async () => {
    const input = await fixture();
    const notAccepted = await verifyOriginal({
      ...input,
      sat: '1250000000',
      btcoResolution: { status: 'not-found', reason: 'No publication observed for this sat' } as unknown as AssetResolution,
    });
    const notAcceptedCheck = notAccepted.find((c) => c.id === 'btco')!;
    expect(notAcceptedCheck.ok).toBe(false);
    expect(notAcceptedCheck.detail).toContain('No publication observed for this sat');
    const unavailable = await verifyOriginal({
      ...input,
      sat: '1250000000',
      btcoResolution: null,
    });
    expect(unavailable.find((c) => c.id === 'btco')!.ok).toBe(false);
  });
});
