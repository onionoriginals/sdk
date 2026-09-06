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
  /** Its log has not been read yet. Renders as nothing — see the copy note. */
  | 'reading'
  /** Its log WAS read and did not come back usable. A real answer, so it shows. */
  | 'unreadable'
  /** Signed hex is waiting that we cannot rule out belonging to this row. */
  | 'pending-elsewhere';

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
  /** The rows whose signed hex is pushable — `unfinishedInscriptions(records)`. */
  unfinished: PendingInscription[];
  /**
   * Pushable records that no row claims — `unclaimedInscriptions(rows, unfinished)`.
   * Any of them could belong to THIS row, so while one exists no unattributable
   * row may be rebuilt over. See the note on that branch below.
   */
  unclaimed: PendingInscription[];
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
  const { row, unfinished, unclaimed, authorshipDid, signedIn, cel } = input;

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
  // A pushable record nobody's row claims. The durable row is written
  // best-effort AFTER inscribing while the server's record is written DURING
  // the API call, so a row can carry no commit id while signed hex already
  // exists at status 'signed' — and this row might be it. Rebuilding would
  // supersede the very pair the Finish banner is offering to push, stranding
  // a reveal that was already paid to build.
  //
  // There is no join to be more precise with: the record carries no DID and
  // the row this case exists for carries no commit id. So the rule is
  // conservative and self-clearing — finishing or broadcasting the record
  // drops it from `unfinished`, and every row opens back up.
  if (unclaimed.length > 0) return { kind: 'disabled', reason: 'pending-elsewhere' };

  if (!signedIn) return { kind: 'disabled', reason: 'signed-out' };
  if (!authorshipDid) return { kind: 'disabled', reason: 'no-authorship-key' };
  // Not fetched yet vs fetched-and-unusable. Collapsing the two made every row
  // flash "Reading this Original's signed log…" on first paint, and told a user
  // whose log genuinely would not load that it was still loading.
  if (cel === undefined) return { kind: 'disabled', reason: 'reading' };

  const controller = genesisController(cel);
  if (!controller) return { kind: 'disabled', reason: 'unreadable' };
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
 * Pushable records that no row accounts for.
 *
 * A row claims a record by recording its commit id. What is left over cannot be
 * attributed to anything — the store is keyed by funding outpoint and carries
 * no DID, and a row that never recorded a commit id has nothing to match on —
 * so it is treated as possibly belonging to any un-inscribed row.
 */
export function unclaimedInscriptions(
  rows: OriginalRow[],
  unfinished: PendingInscription[]
): PendingInscription[] {
  const claimed = new Set(rows.map((r) => r.commitTxId).filter(Boolean));
  return unfinished.filter((r) => !claimed.has(r.commitTxId));
}
