import { describe, expect, test } from 'bun:test';
import { StampedAuthorEvidence } from './author-evidence';

describe('the author evidence the engine hands the SDK is stamped when it was obtained (P7.10)', () => {
  test('the same evidence keeps its stamp; changed evidence is restamped', async () => {
    let t = Date.parse('2026-10-21T10:00:00Z');
    const stamped = new StampedAuthorEvidence(() => t);
    const v1 = { did: 'did:webvh:Qm1:example.com:alice', log: [{ versionId: '1-Qma' }] };
    stamped.set(v1);
    expect(stamped.get(v1.did)?.obtainedAt).toBe('2026-10-21T10:00:00.000Z');
    t += 60_000;
    // Set again unchanged (a later setup or re-read that found nothing new): when it was obtained stays.
    stamped.set({ ...v1, log: [{ versionId: '1-Qma' }] });
    expect(stamped.get(v1.did)?.obtainedAt).toBe('2026-10-21T10:00:00.000Z');
    t += 60_000;
    const v2 = { ...v1, log: [{ versionId: '1-Qma' }, { versionId: '2-Qmb' }] };
    stamped.set(v2);
    expect(stamped.get(v1.did)).toEqual({ ...v2, obtainedAt: '2026-10-21T10:02:00.000Z' });
    expect(stamped.get('did:vh:other')).toBeUndefined();
  });
});
