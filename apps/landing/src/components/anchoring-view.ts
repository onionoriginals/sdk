/**
 * What the anchoring panel shows (plan 011, PR 10b), as pure functions of the
 * engine's snapshot so the wording and the state cannot drift apart. The
 * publication label, the next step, the sat's holder, the index trust and the
 * off-chain notice are separate lines (section 7, P9.18): none of them
 * stands in for another.
 */
import { demo } from '../content';
import type { DemoAssetState } from '../sdk/engine';

export interface AnchoringView {
  label: string;
  labelNote: string;
  /** `ok` only for `anchored`; everything else is a state still in motion or missing evidence. */
  tone: 'ok' | 'pending' | 'problem';
  actionNote: string | null;
  confirmations: string | null;
  holder: { output: string; note: string } | null;
  holderElsewhere: boolean;
  indexNote: string | null;
  unpublishedNote: string | null;
  /** The next version can be inscribed now: the anchor is accepted and nothing is in flight. */
  canInscribeNext: boolean;
  neverCurrentNote: string | null;
  /**
   * Shown with the label whenever inscriptions after the anchor cannot be
   * checked yet, or publications wait on them: they do not stop the state
   * being current, so they are never left out (section 7, P9.15).
   */
  noticeNote: string | null;
  /** One line per listed inscription, so the notice names what it is about. */
  noticeItems: string[];
}

const IN_FLIGHT = new Set(['resume', 'wait-for-confirmation', 'wait-for-evidence', 'wait-for-bitcoin', 'refused']);

export function anchoringView(anchoring: DemoAssetState['anchoring']): AnchoringView | null {
  if (!anchoring) return null;
  const copy = demo.anchoring;
  const status = anchoring.status;
  const publication = status?.publication ?? 'not-anchored';
  const tone = publication === 'anchored' ? 'ok' : publication === 'unverified' ? 'problem' : 'pending';
  const inFlight = !!status && IN_FLIGHT.has(status.action);
  const unpublished = anchoring.unpublished.length;
  return {
    label: copy.labels[publication] ?? publication,
    labelNote: copy.labelNotes[publication] ?? '',
    tone,
    actionNote: status && IN_FLIGHT.has(status.action)
      ? `${copy.actions[status.action] ?? status.action}${status.action === 'refused' && status.refused ? ` (${status.refused.code})` : ''}`
      : null,
    confirmations: status?.ownership ? copy.confirmations(status.ownership.confirmations) : null,
    holder: status?.ownership ? { output: status.ownership.output, note: copy.holderNote } : null,
    holderElsewhere: status?.heldByThisAccount === false,
    indexNote: status
      ? status.indexes.compared ? copy.indexCompared(status.indexes.used) : copy.indexSingle(status.indexes.used[0] ?? 'unknown')
      : null,
    unpublishedNote: publication === 'anchored' && unpublished > 0 ? copy.unpublished(unpublished) : null,
    canInscribeNext: publication === 'anchored' && unpublished > 0 && !inFlight && status?.heldByThisAccount !== false,
    // An Original is current only when Bitcoin shows its anchor (P7.10).
    neverCurrentNote: publication === 'anchored' ? null : copy.neverCurrentNote,
    noticeNote: status && status.notices.length > 0 ? copy.noticeNote(status.listed.unverifiable.length, status.listed.waiting.length) : null,
    noticeItems: status
      ? [
        ...status.listed.unverifiable.map((u) => copy.unverifiableItem(u.inscription, u.signer, u.signerVersionId)),
        ...status.listed.waiting.map((w) => copy.waitingItem(w.inscription, w.waitingOn)),
      ]
      : [],
  };
}

/**
 * Whether the label can still change by itself: anything short of anchored
 * with nothing in flight. The status read costs the account's provider quota,
 * so a settled panel is not polled.
 */
export function anchoringInMotion(anchoring: DemoAssetState['anchoring']): boolean {
  const status = anchoring?.status;
  if (!status) return false;
  return status.publication !== 'anchored' || IN_FLIGHT.has(status.action);
}

/** The off-chain notice before signing (P9.18): what Bitcoin will not hold. */
export function offChainPreview(asset: Pick<DemoAssetState, 'resource' | 'metadata' | 'author'>): string[] {
  return [
    asset.resource.id,
    ...(asset.metadata ? [asset.metadata.id] : []),
    ...(asset.author ? [demo.anchoring.offChainIdentity(asset.author)] : []),
  ];
}

/** Copy for an anchoring failure, or null when it is not one. */
export function anchoringFailureMessage(err: unknown): string | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AnchoringCancelledError') return demo.anchoring.cancelled;
  if (name === 'SigningSessionExpiredError') return demo.anchoring.sessionExpired;
  if (name === 'AnchoringSubmitError') {
    const e = err as { body?: { message?: string; code?: string; error?: string } };
    return e.body?.message ?? e.body?.code ?? e.body?.error ?? null;
  }
  return null;
}
