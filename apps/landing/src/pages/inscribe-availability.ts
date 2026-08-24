/**
 * Which Bitcoin action, if any, an Original row offers — and when it offers
 * none, why.
 *
 * Two different recoveries can apply to a row and they must never both show:
 *
 *  - FINISH: the inscription was already built and signed, and its hex is on
 *    the server. Nothing needs re-signing; the reveal just needs pushing.
 *    `unfinishedInscriptions` owns that set.
 *  - INSCRIBE: nothing was ever built. The Original is published and stops
 *    there, which is the pre-broadcast resume gap — without this the creator
 *    re-runs the demo and ends up with a second, different did:webvh Original.
 *
 * The interesting case is the third one. Inscribing appends a signed `migrate`
 * event to the Original's CEL, and pre-anchor the CEL accepts only its CURRENT
 * CONTROLLER as signer. So the question is not "does this browser have a key"
 * but "is the key that can author THIS Original one the viewer holds". An
 * Original minted before authorship moved into Turnkey custody was signed by a
 * key that lived in a tab and no longer exists anywhere — it can never be
 * inscribed, by anyone, and saying so plainly beats an enabled button that
 * fails at signing time.
 */
import type { OriginalRow, PendingInscription } from './YourOriginals';
import type { CelLog } from './original-detail-data';

export type InscribeAvailability =
  /** Already inscribed, or already on chain — no recovery applies. */
  | { kind: 'none' }
  /** Signed hex is on the server; push it. */
  | { kind: 'finish'; commitTxId: string }
  /** Never built; hydrate and inscribe. */
  | { kind: 'inscribe' }
  /** Offer nothing, and say this instead. */
  | { kind: 'disabled'; reason: DisabledReason };

export type DisabledReason =
  /** No signing session at all — signing in is the remedy. */
  | 'signed-out'
  /** Signed in, but this client cannot author CEL events. */
  | 'no-authorship-key'
  /** The Original's controller is a key nobody holds any more. */
  | 'foreign-controller'
  /** Its log has not been read yet, so we cannot say either way. */
  | 'unknown';

/**
 * The `did:key` verification method a CEL genesis names as controller, or null.
 * Read from the genesis event's `controller`, which is the model's sole
 * genesis identity.
 */
export function genesisController(cel: CelLog | null | undefined): string | null {
  const genesis = cel?.events?.[0];
  if (genesis?.type !== 'create') return null;
  const controller = genesis.data?.controller;
  return typeof controller === 'string' && controller.startsWith('did:key:') ? controller : null;
}

export interface AvailabilityInput {
  row: OriginalRow;
  /** In-flight inscription records for this user (GET /api/btc/inscribe). */
  records: PendingInscription[];
  /** The rows whose signed hex is pushable — `unfinishedInscriptions(records)`. */
  unfinished: PendingInscription[];
  /** The viewer's authorship `did:key`, or null when they have none. */
  authorshipDid: string | null;
  /** Whether a signing session exists at all. */
  signedIn: boolean;
  /**
   * The Original's hosted CEL. `undefined` means "not fetched yet" — distinct
   * from a fetch that came back empty, which is a real answer.
   */
  cel?: CelLog | null;
}

/** What this row offers. Pure — no DOM, no fetch. */
export function inscribeAvailability(input: AvailabilityInput): InscribeAvailability {
  const { row, records, unfinished, authorshipDid, signedIn, cel } = input;

  // Already on chain: neither recovery applies, whatever else is true.
  if (row.btcoDid || row.inscriptionStatus === 'confirmed') return { kind: 'none' };

  // FINISH wins wherever it applies: the transactions already exist and were
  // paid for, so rebuilding them would strand that spend.
  const pushable = unfinished.find((r) => r.commitTxId === row.commitTxId);
  if (row.commitTxId && pushable) return { kind: 'finish', commitTxId: pushable.commitTxId };
  // A commit we know about but cannot push (superseded, or already broadcast
  // and simply waiting) is still not something to re-inscribe over.
  if (row.commitTxId) return { kind: 'none' };
  // An inscribe was attempted but recorded no commit id — the durable row is
  // written 'pending' once, at inscribe time, so this only ever means in
  // flight. Placed AFTER the Finish branch, which needs a commit id anyway:
  // rows written at inscribe time carry 'pending' too, and closing on it any
  // earlier would swallow the Finish offer.
  if (row.inscriptionStatus === 'pending') return { kind: 'none' };
  if (records.some((r) => r.commitTxId && r.fundingOutpoint && rowMatchesRecord(row, r))) {
    return { kind: 'none' };
  }

  if (!signedIn) return { kind: 'disabled', reason: 'signed-out' };
  if (!authorshipDid) return { kind: 'disabled', reason: 'no-authorship-key' };
  if (cel === undefined) return { kind: 'disabled', reason: 'unknown' };

  const controller = genesisController(cel);
  if (!controller) return { kind: 'disabled', reason: 'unknown' };
  if (controller !== authorshipDid) return { kind: 'disabled', reason: 'foreign-controller' };

  return { kind: 'inscribe' };
}

/**
 * The row as it stands immediately after a successful inscribe.
 *
 * Recording the commit is what CLOSES the action: `inscribeAvailability` sends
 * any row carrying a `commitTxId` home as 'none' (or 'finish', once the server
 * records catch up), so the button cannot be clicked a second time and build a
 * second commit/reveal pair. The durable row catches up on the next load;
 * this is the optimistic copy in between.
 *
 * Shared so both surfaces apply the same rule — the detail page originally set
 * a note and nothing else, and re-enabled its own button.
 */
export function rowAfterInscribe(row: OriginalRow, commitTxId: string | undefined): OriginalRow {
  return { ...row, commitTxId, inscriptionStatus: 'pending' };
}

/**
 * Whether an inscription record belongs to this row. The store is keyed by
 * funding outpoint rather than by DID, so the only honest join is the commit
 * id the row itself recorded — a row with none cannot be matched, which is
 * exactly the "never built" case this feature exists for.
 */
function rowMatchesRecord(row: OriginalRow, record: PendingInscription): boolean {
  return !!row.commitTxId && row.commitTxId === record.commitTxId;
}
