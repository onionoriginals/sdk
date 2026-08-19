import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInscriptionsStore, type InscriptionRecord } from '../inscriptions-store';

const rec = (over: Partial<InscriptionRecord>): InscriptionRecord => ({
  commitTxId: 'c'.repeat(64),
  revealTxId: 'r'.repeat(64),
  inscriptionId: `${'r'.repeat(64)}i0`,
  signedCommitHex: '02aa',
  revealTxHex: '02bb',
  fundingOutpoints: [`${'a'.repeat(64)}:0`],
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

  test('sweepStale finds every un-landed record older than the cutoff, across users', () => {
    const now = Date.parse('2026-08-18T00:00:00.000Z');
    const store = createInscriptionsStore({
      dataDir: mkdtempSync(join(tmpdir(), 'is-')),
      now: () => now,
    });
    const old = '2026-08-10T00:00:00.000Z';
    const fresh = '2026-08-17T23:00:00.000Z';
    store.create('sub-1', rec({ commitTxId: '1'.repeat(64), status: 'signed', createdAt: old }));
    store.create('sub-1', rec({ commitTxId: '2'.repeat(64), status: 'reveal_broadcast', createdAt: old, fundingOutpoints: ['b:1'] }));
    store.create('sub-2', rec({ commitTxId: '3'.repeat(64), status: 'commit_broadcast', createdAt: old }));
    store.create('sub-2', rec({ commitTxId: '4'.repeat(64), status: 'signed', createdAt: fresh, fundingOutpoints: ['b:2'] }));

    const stale = store.sweepStale(24 * 60 * 60_000);
    const keys = stale.map((s) => `${s.subOrgId}:${s.commitTxId[0]}`).sort();
    // Includes the old reveal_broadcast record (2): a reveal that went out and
    // never confirmed is stranded money too — it may have been evicted from
    // the mempool, and nothing else in the system would ever notice.
    expect(keys).toEqual(['sub-1:1', 'sub-1:2', 'sub-2:3']);
    // …but not the fresh one, and not anything already retired.
    store.setStatus('sub-1', '2'.repeat(64), 'confirmed');
    expect(store.sweepStale(24 * 60 * 60_000).map((s) => s.commitTxId[0]).sort()).toEqual(['1', '3']);
  });

  test('a confirmed record is retired: hex dropped, row kept as a join key', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({}));
    store.setStatus('sub-1', 'c'.repeat(64), 'confirmed');
    const r = store.get('sub-1', 'c'.repeat(64))!;
    expect(r.status).toBe('confirmed');
    expect(r.retired).toBe(true);
    expect(r.revealTxHex).toBeUndefined();   // dead weight — the pair landed
    expect(r.signedCommitHex).toBeUndefined();
    expect(store.list('sub-1')).toHaveLength(1); // /me still joins on it
  });

  test('the pending cap counts only records still holding hex — retiring frees the slot', () => {
    const store = createInscriptionsStore({
      dataDir: mkdtempSync(join(tmpdir(), 'is-')),
      maxPending: 2,
    });
    store.create('sub-1', rec({ commitTxId: '1'.repeat(64), fundingOutpoints: ['a:1'] }));
    store.create('sub-1', rec({ commitTxId: '2'.repeat(64), fundingOutpoints: ['a:2'] }));
    expect(() => store.create('sub-1', rec({ commitTxId: '3'.repeat(64), fundingOutpoints: ['a:3'] })))
      .toThrow('STORE_FULL');
    // Terminal records must never lock a creator out of inscribing again.
    store.setStatus('sub-1', '1'.repeat(64), 'confirmed');
    store.create('sub-1', rec({ commitTxId: '3'.repeat(64), fundingOutpoints: ['a:3'] }));
    expect(store.list('sub-1')).toHaveLength(3);
  });

  test('retire drops the recovery artifacts of a terminally-dead superseded pair', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({}));
    store.supersede('sub-1', 'c'.repeat(64));
    store.retire('sub-1', 'c'.repeat(64));
    const r = store.get('sub-1', 'c'.repeat(64))!;
    expect(r.retired).toBe(true);
    expect(r.revealTxHex).toBeUndefined();
    store.retire('sub-1', 'c'.repeat(64)); // idempotent
  });

  test('bindDepositAddress is first-use-wins, per network, and survives a reread', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'is-'));
    const store = createInscriptionsStore({ dataDir });
    expect(store.bindDepositAddress('sub-1', 'mainnet', 'bc1qmine')).toBe('bc1qmine');
    // A later call naming someone ELSE's address gets the bound one back —
    // the route compares and 403s, so this is not a UTXO-lookup proxy.
    expect(store.bindDepositAddress('sub-1', 'mainnet', 'bc1qvictim')).toBe('bc1qmine');
    // Testnet is a DIFFERENT Turnkey account, so a different binding.
    expect(store.bindDepositAddress('sub-1', 'testnet', 'tb1qmine')).toBe('tb1qmine');
    expect(store.bindDepositAddress('sub-2', 'mainnet', 'bc1qtheirs')).toBe('bc1qtheirs');
    expect(createInscriptionsStore({ dataDir }).bindDepositAddress('sub-1', 'mainnet', 'bc1qother'))
      .toBe('bc1qmine');
  });
  test('findByOutpoints returns every LIVE record claiming any of the given outpoints', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({ commitTxId: '1'.repeat(64), fundingOutpoints: ['a:0', 'b:0'] }));
    store.create('sub-1', rec({ commitTxId: '2'.repeat(64), fundingOutpoints: ['c:0'] }));
    // Overlap on ONE outpoint is still a claim — this is the double-spend gate.
    expect(store.findByOutpoints('sub-1', ['b:0', 'z:0']).map((r) => r.commitTxId)).toEqual(['1'.repeat(64)]);
    expect(store.findByOutpoints('sub-1', ['a:0', 'c:0']).map((r) => r.commitTxId).sort())
      .toEqual(['1'.repeat(64), '2'.repeat(64)].sort());
    expect(store.findByOutpoints('sub-1', ['z:0'])).toEqual([]);
    // Superseded records are not live claims.
    store.supersede('sub-1', '1'.repeat(64));
    expect(store.findByOutpoints('sub-1', ['a:0'])).toEqual([]);
  });

  test('a multi-outpoint record is found by EACH of its outpoints', () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'is-')) });
    store.create('sub-1', rec({ fundingOutpoints: ['a:0', 'b:1', 'c:2'] }));
    for (const o of ['a:0', 'b:1', 'c:2']) {
      expect(store.findByOutpoint('sub-1', o)!.commitTxId).toBe('c'.repeat(64));
    }
  });

  /**
   * The live volume already holds records written in the single-outpoint
   * shape. They must keep reading (and completing) after multi-input landed —
   * a shape change that orphans real recovery artifacts strands real funds.
   */
  test('reads a record persisted in the LEGACY single-outpoint shape', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'is-'));
    const legacy = {
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
    };
    mkdirSync(join(dataDir, 'inscriptions'), { recursive: true });
    writeFileSync(join(dataDir, 'inscriptions', 'sub-1.json'), JSON.stringify([legacy]));

    const store = createInscriptionsStore({ dataDir });
    const r = store.get('sub-1', 'c'.repeat(64))!;
    expect(r.fundingOutpoints).toEqual([`${'a'.repeat(64)}:0`]);
    expect(r.revealTxHex).toBe('02bb'); // recovery artifact still reachable
    expect(store.findByOutpoint('sub-1', `${'a'.repeat(64)}:0`)!.commitTxId).toBe('c'.repeat(64));
    expect(store.findByOutpoints('sub-1', [`${'a'.repeat(64)}:0`, 'fresh:0']).map((x) => x.commitTxId))
      .toEqual(['c'.repeat(64)]);
    // …and it can still be driven to completion.
    store.setStatus('sub-1', 'c'.repeat(64), 'confirmed');
    expect(store.get('sub-1', 'c'.repeat(64))!.status).toBe('confirmed');
    expect(store.sweepStale(0)).toEqual([]); // retired on confirm, as for a new-shape record
  });
});
