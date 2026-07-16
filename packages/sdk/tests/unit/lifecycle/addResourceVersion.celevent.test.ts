import { describe, test, expect } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import type { AssetResource, DIDDocument } from '../../../src/types';
import type { CelAppendSkippedEvent } from '../../../src/events/types';
import { hashResource } from '../../../src/utils/validation';

const h = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

function makeAsset(): OriginalsAsset {
  const did: DIDDocument = { id: 'did:cel:zabc' } as DIDDocument;
  const resources: AssetResource[] = [
    { id: 'r', type: 'text', content: 'v1', contentType: 'text/plain', hash: '', version: 1 } as AssetResource,
  ];
  // Fix the hash to match content so continuity checks elsewhere line up.
  const { hashResource } = require('../../../src/utils/validation');
  resources[0].hash = hashResource(Buffer.from('v1', 'utf-8'));
  return new OriginalsAsset(resources, did, []);
}

describe('addResourceVersion: injected CEL appender', () => {
  test('calls the bound appender with the resource-update body and updates resources', async () => {
    const asset = makeAsset();
    const calls: Array<{ type: string; data: any }> = [];
    asset._bindCelAppender(async (type, data) => {
      calls.push({ type, data });
      return 'zHeadDigest'; // pretend the append committed
    });

    const created = await asset.addResourceVersion('r', 'v2', 'text/plain', 'edit');

    expect(created.version).toBe(2);
    expect(calls.length).toBe(1);
    expect(calls[0].type).toBe('update');
    expect(calls[0].data.resourceId).toBe('r');
    // Reference-shaped event (#407 phase 1): the signed body carries toHash, NOT bytes.
    expect(calls[0].data.content).toBeUndefined();
    expect(calls[0].data.toHash).toBe(h('v2'));
    expect(calls[0].data.previousVersionHash).toBe(h('v1'));
    expect(calls[0].data.contentType).toBe('text/plain');
    expect(calls[0].data.toVersion).toBe(2);
    // In-memory resources updated.
    expect(asset.getResourceVersion('r', 2)?.content).toBe('v2');
  });

  test('degrades: no appender bound emits cel:append-skipped and does NOT record provenance', async () => {
    const asset = makeAsset();
    const skipped: CelAppendSkippedEvent[] = [];
    asset.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    const created = await asset.addResourceVersion('r', 'v2', 'text/plain');

    expect(created.version).toBe(2);                       // in-memory still versioned
    expect(asset.getProvenance().resourceUpdates.length).toBe(0); // not provable
    expect(skipped.length).toBe(1);
  });

  test('appender returning null (skip) updates resources but not provenance', async () => {
    const asset = makeAsset();
    asset._bindCelAppender(async () => null); // signer unavailable
    await asset.addResourceVersion('r', 'v2', 'text/plain');
    expect(asset.getResourceVersion('r', 2)?.content).toBe('v2');
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
  });
});
