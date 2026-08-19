import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInscriptionsStore, type InscriptionRecord } from '../inscriptions-store';

const rec = (over: Partial<InscriptionRecord>): InscriptionRecord => ({
  commitTxId: 'c'.repeat(64),
  revealTxId: 'r'.repeat(64),
  inscriptionId: `${'r'.repeat(64)}i0`,
  signedCommitHex: '02aa',
  revealTxHex: '02bb',
  fundingOutpoint: `${'a'.repeat(64)}:0`,
  changeAddress: 'tb1qexample',
  status: 'signed',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('inscriptions-store', () => {
  test('create → get → setStatus roundtrip, per-user isolation', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({}));
    expect(store.get('sub-1', 'c'.repeat(64))!.status).toBe('signed');
    expect(store.get('sub-2', 'c'.repeat(64))).toBeNull();
    store.setStatus('sub-1', 'c'.repeat(64), 'reveal_broadcast');
    expect(store.get('sub-1', 'c'.repeat(64))!.status).toBe('reveal_broadcast');
    expect(store.findByOutpoint('sub-1', `${'a'.repeat(64)}:0`)!.commitTxId).toBe('c'.repeat(64));
  });

  test('supersede preserves the record (and its reveal hex) while freeing the outpoint', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({}));
    store.supersede('sub-1', 'c'.repeat(64));
    const r = store.get('sub-1', 'c'.repeat(64))!;
    expect(r.superseded).toBe(true);
    expect(r.revealTxHex).toBe('02bb'); // recovery artifact intact
    // The outpoint is free for a rebuilt pair…
    expect(store.findByOutpoint('sub-1', `${'a'.repeat(64)}:0`)).toBeNull();
    // …and a new live record on it wins the lookup.
    store.create('sub-1', rec({ commitTxId: 'd'.repeat(64) }));
    expect(store.findByOutpoint('sub-1', `${'a'.repeat(64)}:0`)!.commitTxId).toBe('d'.repeat(64));
  });

  test('sweepStale finds only never-revealed records older than the cutoff, across users', () => {
    const now = Date.parse('2026-08-18T00:00:00.000Z');
    const store = createInscriptionsStore({
      dataDir: mkdtempSync(join(tmpdir(), 'is-')),
      now: () => now,
    });
    const old = '2026-08-10T00:00:00.000Z';
    const fresh = '2026-08-17T23:00:00.000Z';
    store.create('sub-1', rec({ commitTxId: '1'.repeat(64), status: 'signed', createdAt: old }));
    store.create('sub-1', rec({ commitTxId: '2'.repeat(64), status: 'reveal_broadcast', createdAt: old, fundingOutpoint: 'b:1' }));
    store.create('sub-2', rec({ commitTxId: '3'.repeat(64), status: 'commit_broadcast', createdAt: old }));
    store.create('sub-2', rec({ commitTxId: '4'.repeat(64), status: 'signed', createdAt: fresh, fundingOutpoint: 'b:2' }));

    const stale = store.sweepStale(24 * 60 * 60_000);
    const keys = stale.map((s) => `${s.subOrgId}:${s.commitTxId[0]}`).sort();
    expect(keys).toEqual(['sub-1:1', 'sub-2:3']);
  });
});
