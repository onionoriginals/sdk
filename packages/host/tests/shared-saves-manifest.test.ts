/**
 * The hosted manifest's missing items (P14.10; P7.1, P7.4): the shared-host
 * route lists each signer DID history the host does not hold, with its role,
 * and is complete only when neither a resource version nor a signer history
 * is missing. Completeness is never judged from resources alone.
 */
import { describe, expect, test } from 'bun:test';
import type { OriginalsReport } from '@originals/vh/originals';
import { hostedMissing } from '../src/shared-saves.js';

const AUTHOR = 'did:webvh:QmAuthor:example.com';
const EDITOR = 'did:vh:QmEditor';
const line = (state: Record<string, unknown>) => JSON.stringify({ versionId: '1-Qm', versionTime: '2026-10-23T12:00:00Z', parameters: {}, state, proof: [] });
const lines = [
  line({ author: { did: AUTHOR } }),
  line({ author: { did: AUTHOR }, editor: { did: EDITOR } }),
];
const report = (missing: Array<Record<string, unknown>> = []) => ({ resources: { missing } }) as unknown as OriginalsReport;

describe('hosted manifest missing items (P14.10)', () => {
  test('a signer history the host does not hold is listed with its role', () => {
    expect(hostedMissing(lines, report(), () => true)).toEqual([]);
    expect(hostedMissing(lines, report(), (did) => did !== EDITOR)).toEqual([{ kind: 'identity', did: EDITOR, role: 'editor' }]);
    expect(hostedMissing(lines, report(), () => false)).toEqual([
      { kind: 'identity', did: AUTHOR, role: 'author' },
      { kind: 'identity', did: EDITOR, role: 'editor' },
    ]);
  });

  test('resource versions come first, in exactly their shape', () => {
    const v = { resource: 'art', version: 2, digest: 'zQmD', mediaType: 'image/svg+xml', size: 3, versionId: '2-Qm', bytes: 'missing' };
    expect(hostedMissing(lines, report([v]), (did) => did === AUTHOR)).toEqual([
      { kind: 'resource', resource: 'art', version: 2, digest: 'zQmD', versionId: '2-Qm' },
      { kind: 'identity', did: EDITOR, role: 'editor' },
    ]);
  });
});
