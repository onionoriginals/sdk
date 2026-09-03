/**
 * #493 item 3 — the deposit quote used to be sized for 8,000 bytes no matter
 * what the creator was about to inscribe, because this client sent no
 * `contentBytes` hint. The real reveal carries the artwork PLUS the DID
 * document and the whole CEL log, and above ~12.8 KB the default under-funds:
 * "Insufficient funds" AFTER the deposit, with no amount to reconcile.
 *
 * The hint must only ever over-estimate — the excess returns as change — so
 * these tests pin the direction, not a precise byte count.
 */
import { describe, test, expect } from 'bun:test';
import { inscriptionContentBytes } from './Demo';
import type { DemoAssetState } from '../sdk/engine';

const entry = (i: number): DemoAssetState['celLog'][number] => ({
  type: i === 0 ? 'create' : 'update',
  data: { note: `event ${i}`.repeat(20) },
  ...(i > 0 ? { previousEvent: 'u'.repeat(50) } : {}),
  proof: [{ type: 'OriginalsCelProof', cryptosuite: 'eddsa-jcs-2022', proofValue: 'z'.repeat(88) }],
});

const asset = (over: Partial<DemoAssetState> = {}): DemoAssetState => ({
  layer: 'did:webvh',
  did: 'did:cel:u'.padEnd(60, 'x'),
  resource: { id: 'artwork.svg', hash: 'h', contentType: 'image/svg+xml', content: '<svg/>', version: 1 },
  credentials: 0,
  celLog: [entry(0)],
  ...over,
});

describe('inscriptionContentBytes', () => {
  test('never quotes below the bytes of the media itself', () => {
    const content = '<svg>'.padEnd(20_000, 'x') + '</svg>';
    expect(inscriptionContentBytes(asset({ resource: { ...asset().resource, content } }))).toBeGreaterThanOrEqual(
      new TextEncoder().encode(content).length
    );
  });

  test('counts UTF-8 bytes, not characters', () => {
    const content = '🎨'.repeat(1_000); // 4 bytes each, 2 UTF-16 units each
    const bytes = inscriptionContentBytes(asset({ resource: { ...asset().resource, content } }));
    expect(bytes).toBeGreaterThanOrEqual(4_000);
  });

  test('grows with the log — every event ships in the reveal', () => {
    const one = inscriptionContentBytes(asset({ celLog: [entry(0)] }));
    const five = inscriptionContentBytes(asset({ celLog: [0, 1, 2, 3, 4].map(entry) }));
    expect(five).toBeGreaterThan(one);
  });

  test('includes the metadata resource when there is one', () => {
    const without = inscriptionContentBytes(asset());
    const withMeta = inscriptionContentBytes(
      asset({ metadata: { id: 'metadata.json', hash: 'm', content: JSON.stringify({ style: 'orbits' }).padEnd(2_000, ' ') } })
    );
    expect(withMeta - without).toBeGreaterThanOrEqual(2_000);
  });
});
