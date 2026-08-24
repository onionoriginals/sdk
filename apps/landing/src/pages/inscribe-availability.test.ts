/**
 * Which action a row offers. The three cases the feature turns on:
 * an inscribable row, a Finish row, and a row with no usable key — plus the
 * rule that Finish and Inscribe never appear together.
 */
import { describe, test, expect } from 'bun:test';
import { inscribeAvailability, genesisController } from './inscribe-availability';
import type { OriginalRow, PendingInscription } from './YourOriginals';
import type { CelLog } from './original-detail-data';

const MINE = 'did:key:z6Mkj2fLd1Cft3Y1d4keoArcN9fxSUKUXo49sdyPDHA796qk';
const THEIRS = 'did:key:z6MkvvR62AzMMmNR4NS9wB5ksUCLNfgDGTbG6uEKM3MU6NWz';

const celFor = (controller: string): CelLog => ({
  events: [{ type: 'create', data: { controller, resources: [] } }],
});

const row = (over: Partial<OriginalRow> = {}): OriginalRow => ({
  did: 'did:webvh:scid:example.test:abc',
  title: 'Untitled',
  resourceHash: 'ff',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const record = (over: Partial<PendingInscription> = {}): PendingInscription => ({
  commitTxId: 'commit-1',
  revealTxId: 'reveal-1',
  inscriptionId: 'insc-1',
  fundingOutpoint: 'out:0',
  status: 'signed',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const base = {
  records: [] as PendingInscription[],
  unfinished: [] as PendingInscription[],
  authorshipDid: MINE,
  signedIn: true,
  cel: celFor(MINE) as CelLog | null | undefined,
};

describe('genesisController', () => {
  test('reads the did:key the genesis event names', () => {
    expect(genesisController(celFor(MINE))).toBe(MINE);
  });

  test('null for a log that does not start at genesis', () => {
    expect(genesisController({ events: [{ type: 'migrate', data: {} }] })).toBeNull();
  });

  test('null for no log, and for a genesis with no controller', () => {
    expect(genesisController(null)).toBeNull();
    expect(genesisController({ events: [{ type: 'create', data: {} }] })).toBeNull();
  });
});

describe('an inscribable row', () => {
  test('offers Inscribe when nothing was ever built and the key is mine', () => {
    expect(inscribeAvailability({ ...base, row: row() })).toEqual({ kind: 'inscribe' });
  });
});

describe('a row with stored hex', () => {
  test('offers Finish, not Inscribe', () => {
    const rec = record();
    const got = inscribeAvailability({
      ...base,
      row: row({ commitTxId: 'commit-1' }),
      records: [rec],
      unfinished: [rec],
    });
    expect(got).toEqual({ kind: 'finish', commitTxId: 'commit-1' });
    // The two recoveries are mutually exclusive: rebuilding over signed,
    // paid-for transactions would strand that spend.
    expect(got.kind).not.toBe('inscribe');
  });

  test('offers neither when the commit exists but is not pushable', () => {
    // Superseded, or simply broadcast and waiting: not re-inscribable either.
    const rec = record({ superseded: true });
    expect(
      inscribeAvailability({ ...base, row: row({ commitTxId: 'commit-1' }), records: [rec], unfinished: [] })
    ).toEqual({ kind: 'none' });
  });
});

describe('a row with no usable key', () => {
  test('disabled, naming sign-in, when there is no session', () => {
    expect(inscribeAvailability({ ...base, row: row(), signedIn: false })).toEqual({
      kind: 'disabled',
      reason: 'signed-out',
    });
  });

  test('disabled when this client cannot author at all', () => {
    expect(inscribeAvailability({ ...base, row: row(), authorshipDid: null })).toEqual({
      kind: 'disabled',
      reason: 'no-authorship-key',
    });
  });

  test('disabled when the Original answers to a key nobody holds', () => {
    // The pre-custody case: minted with a key that lived in a tab. Pre-anchor
    // the CEL accepts only its current controller, so no other key can ever
    // sign this migrate — an enabled button here would fail at signing time.
    expect(inscribeAvailability({ ...base, row: row(), cel: celFor(THEIRS) })).toEqual({
      kind: 'disabled',
      reason: 'foreign-controller',
    });
  });

  test('disabled as unknown while the log has not been read', () => {
    expect(inscribeAvailability({ ...base, row: row(), cel: undefined })).toEqual({
      kind: 'disabled',
      reason: 'unknown',
    });
  });

  test('unknown, not inscribable, when the log came back unreadable', () => {
    expect(inscribeAvailability({ ...base, row: row(), cel: null })).toEqual({
      kind: 'disabled',
      reason: 'unknown',
    });
  });
});

describe('rows already on chain', () => {
  test('offer nothing once inscribed', () => {
    expect(inscribeAvailability({ ...base, row: row({ btcoDid: 'did:btco:123' }) })).toEqual({ kind: 'none' });
  });

  test('offer nothing once confirmed', () => {
    expect(
      inscribeAvailability({ ...base, row: row({ inscriptionStatus: 'confirmed' }) })
    ).toEqual({ kind: 'none' });
  });

  test('being on chain wins even with no key and no session', () => {
    expect(
      inscribeAvailability({
        ...base,
        row: row({ btcoDid: 'did:btco:123' }),
        signedIn: false,
        authorshipDid: null,
      })
    ).toEqual({ kind: 'none' });
  });
});
