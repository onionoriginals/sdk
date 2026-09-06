/**
 * Which action a row offers. The three cases the feature turns on:
 * an inscribable row, a Finish row, and a row with no usable key — plus the
 * rule that Finish and Inscribe never appear together.
 */
import { describe, test, expect } from 'bun:test';
import {
  inscribeAvailability,
  genesisController,
  rowAfterInscribe,
  unclaimedInscriptions,
} from './inscribe-availability';
import { inscribeIsComplete } from '../components/Demo';
import { yourOriginals } from '../content';
import type { DisabledReason } from './inscribe-availability';
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
  unfinished: [] as PendingInscription[],
  unclaimed: [] as PendingInscription[],
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
      inscribeAvailability({ ...base, row: row({ commitTxId: 'commit-1' }), unfinished: [] })
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

  test('reading — not inscribable — while the log has not been fetched', () => {
    // Distinct from a log that came back bad: this is first paint, and it
    // renders as NOTHING rather than flashing a note under every row.
    expect(inscribeAvailability({ ...base, row: row(), cel: undefined })).toEqual({
      kind: 'disabled',
      reason: 'reading',
    });
  });

  test('unreadable — a real answer — when the log came back unusable', () => {
    expect(inscribeAvailability({ ...base, row: row(), cel: null })).toEqual({
      kind: 'disabled',
      reason: 'unreadable',
    });
  });

  test('unreadable too when the log has no genesis controller to sign as', () => {
    expect(
      inscribeAvailability({ ...base, row: row(), cel: { events: [{ type: 'create', data: {} }] } })
    ).toEqual({ kind: 'disabled', reason: 'unreadable' });
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

/**
 * #506 removed "inscribed" from a commit-only broadcast in the demo. The
 * resume path reintroduced it — any inscription snapshot read as done — until
 * review caught it on #515. These pin the distinction and the copy.
 */
describe('a resumed inscription that only got its commit out', () => {
  test('only a broadcast reveal counts as complete', () => {
    expect(inscribeIsComplete('reveal_broadcast')).toBe(true);
    expect(inscribeIsComplete('commit_broadcast')).toBe(false);
    // Fail closed: a status we cannot read is not a landed reveal.
    expect(inscribeIsComplete(null)).toBe(false);
    expect(inscribeIsComplete(undefined)).toBe(false);
  });

  test('the commit-only copy never claims the inscription exists', () => {
    const copy = yourOriginals.inscribe.commitOnly;
    expect(copy).not.toMatch(/\binscribed\b/i);
    // and it says the obligation is discharged, so nobody goes looking.
    expect(copy).toMatch(/nothing more is owed/i);
  });

  test('the done copy is reserved for a reveal that actually landed', () => {
    expect(yourOriginals.inscribe.done).toMatch(/inscribed/i);
    expect(yourOriginals.inscribe.done).not.toBe(yourOriginals.inscribe.commitOnly);
  });
});

/**
 * The detail page used to set a note after a successful inscribe and nothing
 * else — the row was untouched, `action` recomputed to 'inscribe', the button
 * re-enabled, and a second click built and paid for a second commit/reveal
 * pair. Both surfaces now close the action through the same helper.
 */
describe('a row that was just inscribed', () => {
  test('records the commit and reads as pending', () => {
    expect(rowAfterInscribe(row(), 'commit-9')).toMatchObject({
      commitTxId: 'commit-9',
      inscriptionStatus: 'pending',
    });
  });

  test('offers no second inscribe, so the button cannot be clicked twice', () => {
    // The server records have not caught up yet — the state right after the
    // call returns, which is exactly when a second click was possible.
    const after = rowAfterInscribe(row(), 'commit-9');
    expect(inscribeAvailability({ ...base, row: after })).toEqual({ kind: 'none' });
  });

  test('offers Finish once the record for that commit arrives', () => {
    const after = rowAfterInscribe(row(), 'commit-9');
    const rec = record({ commitTxId: 'commit-9' });
    expect(
      inscribeAvailability({ ...base, row: after, unfinished: [rec] })
    ).toEqual({ kind: 'finish', commitTxId: 'commit-9' });
  });

  test('a commit id we never got back still closes the action', () => {
    // resumeInscribe can return ok with no commitTxId. Re-inscribing on that
    // is the one thing that must not happen, so the row goes to 'pending'
    // regardless and the selector reads 'pending' alone as in flight.
    const after = rowAfterInscribe(row(), undefined);
    expect(after.inscriptionStatus).toBe('pending');
    expect(inscribeAvailability({ ...base, row: after })).toEqual({ kind: 'none' });
  });

  test('closing on pending does not swallow a Finish offer', () => {
    // The durable row is written 'pending' at inscribe time, so the row a
    // Finish banner points at carries BOTH a commit id and 'pending'.
    const rec = record({ commitTxId: 'commit-9' });
    expect(
      inscribeAvailability({
        ...base,
        row: row({ commitTxId: 'commit-9', inscriptionStatus: 'pending' }),
        unfinished: [rec],
      })
    ).toEqual({ kind: 'finish', commitTxId: 'commit-9' });
  });
});

/**
 * The guard that used to be dead code: it joined on `commitTxId`, downstream
 * of the early return that had already sent every row carrying one home. So
 * the case it was written for — signed hex on the server while the row that
 * paid for it recorded nothing — could never fire, and /me compounded it by
 * feeding `records` the already-narrowed `unfinished` array.
 */
describe('signed hex waiting that no row accounts for', () => {
  const loose = record({ commitTxId: 'commit-loose', status: 'signed' });

  test('a record no row claims is unclaimed', () => {
    expect(unclaimedInscriptions([row()], [loose])).toEqual([loose]);
  });

  test('a record a row claims is not', () => {
    expect(unclaimedInscriptions([row({ commitTxId: 'commit-loose' })], [loose])).toEqual([]);
  });

  test('a row that claims a DIFFERENT commit does not account for it', () => {
    expect(unclaimedInscriptions([row({ commitTxId: 'commit-other' })], [loose])).toEqual([loose]);
  });

  test('an unattributable row is disabled rather than rebuilt over', () => {
    // The rebuild would supersede the very pair the Finish banner is offering
    // to push, stranding a reveal that was already paid to build.
    expect(inscribeAvailability({ ...base, row: row(), unclaimed: [loose] })).toEqual({
      kind: 'disabled',
      reason: 'pending-elsewhere',
    });
  });

  test('it outranks having a usable key: the money is what is at stake', () => {
    expect(
      inscribeAvailability({ ...base, row: row(), unclaimed: [loose], cel: celFor(THEIRS) })
    ).toEqual({ kind: 'disabled', reason: 'pending-elsewhere' });
  });

  test('the row that DOES claim it still gets Finish', () => {
    expect(
      inscribeAvailability({
        ...base,
        row: row({ commitTxId: 'commit-loose' }),
        unfinished: [loose],
        unclaimed: [],
      })
    ).toEqual({ kind: 'finish', commitTxId: 'commit-loose' });
  });

  test('self-clearing: once nothing is pushable, rows open back up', () => {
    expect(inscribeAvailability({ ...base, row: row(), unclaimed: [] })).toEqual({
      kind: 'inscribe',
    });
  });

  test('the copy points at the click that clears it', () => {
    const copy = yourOriginals.inscribe.reasons['pending-elsewhere'];
    expect(copy).toMatch(/finish/i);
    // and never implies the Original itself is the problem
    expect(copy).not.toMatch(/can’t|cannot/i);
  });
});

/**
 * Every reason the selector can return has copy, and every string in the copy
 * block is reachable. Two were dead when review caught them: `hydrating` (the
 * button never said which half of the work it was in) and `failed`, which also
 * promised "nothing was spent" — untrue for a failure after the commit
 * broadcast, so it was removed rather than wired up.
 */
describe('the disabled copy', () => {
  const reasons: DisabledReason[] = [
    'signed-out',
    'no-authorship-key',
    'foreign-controller',
    'reading',
    'unreadable',
    'pending-elsewhere',
  ];

  test('every reason has a string', () => {
    for (const r of reasons) {
      expect(yourOriginals.inscribe.reasons[r]).toBeTruthy();
    }
  });

  test('and there are no strings without a reason', () => {
    expect(Object.keys(yourOriginals.inscribe.reasons).sort()).toEqual([...reasons].sort());
  });

  test('no reason claims nothing was spent', () => {
    // Only the provider's own submit status can say that, and it is read
    // separately. A blanket reassurance here would be a guess about money.
    for (const r of reasons) {
      expect(yourOriginals.inscribe.reasons[r]).not.toMatch(/nothing was spent/i);
    }
  });
});
