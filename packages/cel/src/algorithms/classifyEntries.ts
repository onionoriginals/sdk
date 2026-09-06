/**
 * Pure, display-oriented entry classification — no provider, no I/O.
 *
 * `verified: false` on every returned entry means the class is a CLAIM: an
 * unverified log can contain an entry whose `data.author` is a lie, and only
 * `verifyEventLog` (which checks the signatures and the reinscription sat
 * gate) can promote it. Anything security-relevant must read the verification
 * result's `authorClass`/`creatorKeys`/`holders`, not this fold.
 */
import type { EventLog, LogEntry, EventType, EntryAuthorClass, AssetState } from '../types.js';

export interface ClassifiedEntry {
  index: number;
  type: EventType;
  authorKey?: string;
  authorClass: EntryAuthorClass;
  /** false when derived from the log alone, without verification. */
  verified: boolean;
}

/** The DID a log entry claims as its signer: `data.author`, else the first non-witness proof's VM DID. */
export function claimedSignerDid(entry: { data?: unknown; proof?: unknown }): string | undefined {
  const author = (entry.data as { author?: unknown } | null | undefined)?.author;
  if (typeof author === 'string') return author;
  if (Array.isArray(entry.proof)) {
    for (const p of entry.proof) {
      const rec = p as { verificationMethod?: unknown; cryptosuite?: unknown } | null;
      if (!rec || typeof rec.verificationMethod !== 'string') continue;
      // Skip witness proofs (bitcoin-ordinals and generic witness suites do
      // not name the controller).
      if (typeof rec.cryptosuite === 'string' && rec.cryptosuite.includes('witness')) continue;
      if (typeof rec.cryptosuite === 'string' && rec.cryptosuite.startsWith('bitcoin-')) continue;
      return rec.verificationMethod.split('#')[0];
    }
  }
  return undefined;
}

/**
 * The genesis lineage DID a create event names — `data.controller`, the ONLY
 * genesis identity in the model (the protocol starts fresh: there is no legacy
 * `data.creator` / `data.did` shape to read).
 */
function genesisControllerDid(createEvent: LogEntry | undefined): string | undefined {
  const controller = (createEvent?.data as { controller?: unknown } | null | undefined)?.controller;
  return typeof controller === 'string' ? controller : undefined;
}

/**
 * Labels a log's entries as creator / holder / unattributed by reading the
 * lineage OFF THE LOG (genesis `data.controller`, then each pre-anchor
 * rotateKey's `newController`; the lineage freezes at the first btco migrate).
 * Unsigned and unchecked — see the module doc: this is for display.
 */
export function classifyLogEntries(log: EventLog): ClassifiedEntry[] {
  const events = log?.events ?? [];
  const lineage = new Set<string>();
  const genesisController = genesisControllerDid(events[0]);
  if (genesisController !== undefined) lineage.add(genesisController);

  // The anchor boundary: the first migrate to the btco layer.
  const anchorIndex = events.findIndex(
    (e) => e.type === 'migrate' && (e.data as { layer?: unknown } | null | undefined)?.layer === 'btco'
  );

  const out: ClassifiedEntry[] = [];
  for (let i = 0; i < events.length; i++) {
    const entry = events[i];
    const postAnchor = anchorIndex !== -1 && i > anchorIndex;
    // Pre-anchor rotations extend the lineage (post-anchor ones are invalid,
    // but this fold does not judge validity — it reads what the log says and
    // ignores post-anchor rotations exactly as the verifier rejects them).
    if (!postAnchor && entry.type === 'rotateKey') {
      const nc = (entry.data as { newController?: unknown } | null | undefined)?.newController;
      if (typeof nc === 'string') lineage.add(nc);
    }
    const signer = claimedSignerDid(entry);
    let authorClass: EntryAuthorClass;
    if (postAnchor && entry.type !== 'update') {
      // The verifier REJECTS every post-anchor non-update entry (rotateKey,
      // deactivate, migrate, transfer, a hand-built create) — it never
      // classes one as creator or holder. Mirror that here regardless of
      // lineage: labeling a rejected forgery "creator" because its signer
      // string matches the lineage would have the display fold vouching for
      // an entry the verifier refuses.
      authorClass = 'unattributed';
    } else if (signer === undefined || lineage.size === 0) {
      authorClass = 'unattributed';
    } else if (lineage.has(signer)) {
      authorClass = 'creator';
    } else {
      authorClass = postAnchor ? 'holder' : 'unattributed';
    }
    out.push({
      index: i,
      type: entry.type,
      ...(signer !== undefined ? { authorKey: signer } : {}),
      authorClass,
      verified: false,
    });
  }
  return out;
}

/**
 * Shared custody-fold state for the layer managers' `getCurrentState` folds —
 * the SECOND line of defense behind the verifier's holder allowlist: even a
 * hand-built log cannot smuggle a holder entry's fields into
 * name/resources/creator/controller/did/layer or the metadata catch-all,
 * because the managers route non-lineage post-anchor updates into
 * `state.custody` and nowhere else. Lineage is read from the log alone (the
 * managers never verify proofs), which is enough for a defensive fold: an
 * unverified log's state was never a trust statement.
 */
export interface CustodyFoldState {
  lineage: Set<string>;
  anchored: boolean;
  custody: NonNullable<AssetState['custody']>;
}

export function beginCustodyFold(createEvent: LogEntry | undefined): CustodyFoldState {
  const lineage = new Set<string>();
  const genesisController = genesisControllerDid(createEvent);
  if (genesisController !== undefined) lineage.add(genesisController);
  return { lineage, anchored: false, custody: [] };
}

/**
 * What a manager fold should do with one event:
 * - `'fold'`: process normally (a creator-lineage claim).
 * - `'holder'`: the entry was captured into `custody`; fold NOTHING else from it.
 * - `'ignore'`: a post-anchor rotateKey — never valid, must not touch
 *   `controller` (or anything else).
 */
export type CustodyStepAction = 'fold' | 'holder' | 'ignore';

export function custodyFoldStep(fold: CustodyFoldState, event: LogEntry, index: number): CustodyStepAction {
  const data = event.data as Record<string, unknown> | null;
  if (event.type === 'rotateKey') {
    if (fold.anchored) return 'ignore';
    const nc = data?.newController;
    if (typeof nc === 'string') fold.lineage.add(nc);
    return 'fold';
  }
  // The anchor boundary: a btco migrate — first-class, or the legacy
  // update-sniffed shape (sourceDid + layer + migratedAt).
  const isBtcoMigration =
    data?.layer === 'btco' &&
    (event.type === 'migrate' ||
      (event.type === 'update' && data?.sourceDid !== undefined && data?.migratedAt !== undefined));
  if (isBtcoMigration) {
    fold.anchored = true;
    return 'fold';
  }
  if (fold.anchored && event.type === 'update') {
    const signer = claimedSignerDid(event);
    if (signer === undefined || !fold.lineage.has(signer)) {
      fold.custody.push({
        author: signer ?? '(unattributed)',
        ...(typeof data?.statement === 'string' ? { statement: data.statement } : {}),
        ...(typeof data?.occurredAt === 'string' ? { occurredAt: data.occurredAt } : {}),
        eventIndex: index,
      });
      return 'holder';
    }
  }
  return 'fold';
}

export function finishCustodyFold(fold: CustodyFoldState, state: AssetState): void {
  if (fold.custody.length > 0) {
    state.custody = fold.custody;
    state.holders = [...new Set(fold.custody.map((c) => c.author))];
  }
}
