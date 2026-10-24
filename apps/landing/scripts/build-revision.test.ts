import { describe, test, expect } from 'bun:test';
import { buildRevision } from './build-revision';

// #976 B, gap G6. The receipt requires spaRevision to equal the source SHA, so
// a bundle built from a tree with uncommitted changes must never claim the
// clean commit.
const SHA = 'a'.repeat(40);
const git = (head: string | null, status: string | null) => (args: string[]) => {
  if (args[0] === 'rev-parse') {
    if (head === null) throw new Error('not a repo');
    return `${head}\n`;
  }
  if (status === null) throw new Error('status failed');
  return status;
};

describe('buildRevision', () => {
  test('a clean tree is its HEAD', () => {
    expect(buildRevision({}, git(SHA, ''))).toBe(SHA);
  });

  test('a dirty tree is marked -dirty', () => {
    expect(buildRevision({}, git(SHA, ' M apps/landing/src/content.ts\n'))).toBe(`${SHA}-dirty`);
  });

  test('a tree whose status cannot be read is not claimed clean', () => {
    expect(buildRevision({}, git(SHA, null))).toBe(`${SHA}-dirty`);
  });

  test('Railway supplies the deployed commit, which is clean by construction', () => {
    expect(buildRevision({ RAILWAY_GIT_COMMIT_SHA: SHA }, git(null, null))).toBe(SHA);
  });

  test('no repository and no Railway SHA is unknown, never a guess', () => {
    expect(buildRevision({}, git(null, null))).toBeNull();
    expect(buildRevision({ RAILWAY_GIT_COMMIT_SHA: 'not-a-sha' }, git(null, null))).toBeNull();
  });
});
