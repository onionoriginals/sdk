import { describe, expect, test } from 'bun:test';
import type { SatSnapshot } from '@originals/sdk';
import { encodeSatSnapshot, snapshotContentBytes } from '../src/sat-snapshot-codec.js';

const META = Uint8Array.from([0xa1, 0x00, 0xff]);

const snapshotOf = (bodies: Array<SatSnapshot['publications'][number]['body']>): SatSnapshot =>
  ({ publications: bodies.map((body, k) => ({ id: `${'a'.repeat(64)}i${k}`, body })) }) as unknown as SatSnapshot;

describe('sat snapshot codec', () => {
  test('metadata kept on an unread body is base64 like a complete body\'s, never a JSON object of indices (P14.12, P9.12)', () => {
    const snapshot = snapshotOf([
      { status: 'complete', mediaType: 'image/png', bytes: Uint8Array.from([1, 2]), metadata: META },
      { status: 'unavailable', reason: 'not-requested', mediaType: 'image/png', contentLength: 9, metadata: META },
      { status: 'unavailable', reason: 'not-requested', mediaType: 'image/png', contentLength: 9, metadata: null },
      { status: 'unsupported', reason: 'delegated', mediaType: null, metadata: META },
    ]);
    const wire = JSON.parse(JSON.stringify(encodeSatSnapshot(snapshot))) as { publications: Array<{ body: { bytes?: unknown; metadata?: unknown } }> };
    const bodies = wire.publications.map((p) => p.body);
    expect(bodies[0]).toMatchObject({ bytes: 'AQI=', metadata: 'oQD/' });
    expect(bodies[1].metadata).toBe('oQD/');
    expect(bodies[2].metadata).toBeNull();
    expect(bodies[3].metadata).toBe('oQD/');
  });

  test('snapshotContentBytes counts metadata kept on an unread body', () => {
    const snapshot = snapshotOf([
      { status: 'complete', mediaType: 'image/png', bytes: Uint8Array.from([1, 2]), metadata: META },
      { status: 'unavailable', reason: 'not-requested', mediaType: 'image/png', contentLength: 9, metadata: META },
      { status: 'unsupported', reason: 'content-encoding', mediaType: null, metadata: META },
      { status: 'unavailable', reason: 'over-budget', mediaType: 'image/png', contentLength: 9 },
    ]);
    expect(snapshotContentBytes(snapshot)).toBe(2 + 3 * 3);
  });
});
