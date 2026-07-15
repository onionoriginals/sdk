/**
 * Resource-timeline head derivation (#407 phase 2 — content-as-ordinal).
 *
 * The anchoring inscription's CONTENT is the asset's "most-recent resource":
 * the current head of the resource timeline. Writer and verifier MUST agree on
 * which resource that is, so both derive it from the LOG here (never from the
 * mutable in-memory resources array):
 *
 *  - the last resource-shaped `update` event's signed `toHash` (the latest
 *    addResourceVersion), or
 *  - failing any update, the genesis PRIMARY resource (index 0).
 *
 * A degraded update (in-memory advanced, log did not) is deliberately invisible
 * here — the log is the source of provenance truth, so the writer inscribes the
 * log-provable head, and the verifier checks against that same head.
 */
import type { EventLog } from './types.js';
import { decodeDigestMultibase } from './hash.js';

export interface ResourceHead {
  /** Logical resource id (may be '' for legacy id-less genesis). */
  resourceId: string;
  /** Content hash as hex sha256 (AssetResource.hash form). */
  hash: string;
  /** MIME type, when the log recorded one. */
  contentType?: string;
  /** Version number, when derivable (genesis = 1, updates = toVersion). */
  version?: number;
}

/**
 * The current head of the resource timeline folded from the log, or undefined
 * when the log is empty / shapeless (no genesis resources and no updates).
 */
export function mostRecentResourceHead(log: EventLog): ResourceHead | undefined {
  if (!log || !Array.isArray(log.events) || log.events.length === 0) return undefined;

  // Last resource-shaped update wins (resourceId + previousVersionHash + toHash).
  // Witness-ack updates (no resourceId/previousVersionHash) and generic updates
  // are skipped.
  for (let i = log.events.length - 1; i >= 1; i--) {
    const ev = log.events[i];
    if (ev.type !== 'update') continue;
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const resourceId = typeof d.resourceId === 'string' ? d.resourceId : undefined;
    const previousVersionHash = typeof d.previousVersionHash === 'string' ? d.previousVersionHash : undefined;
    const toHash = typeof d.toHash === 'string' && d.toHash.length > 0 ? d.toHash : undefined;
    if (resourceId && previousVersionHash && toHash) {
      return {
        resourceId,
        hash: toHash,
        contentType: typeof d.contentType === 'string' ? d.contentType : undefined,
        version: typeof d.toVersion === 'number' ? d.toVersion : undefined,
      };
    }
  }

  // No update: the genesis PRIMARY resource (index 0 — createAsset seeds the
  // genesis name from resources[0].id, so index 0 is the primary media).
  const genesis = log.events[0]?.data as { resources?: unknown; name?: unknown } | undefined;
  const gres = genesis?.resources;
  if (!Array.isArray(gres) || gres.length === 0) return undefined;
  const first = gres[0] as { id?: unknown; digestMultibase?: unknown; mediaType?: unknown };
  if (typeof first.digestMultibase !== 'string') return undefined;
  let hash: string;
  try {
    hash = Buffer.from(decodeDigestMultibase(first.digestMultibase)).toString('hex');
  } catch {
    return undefined;
  }
  return {
    resourceId: typeof first.id === 'string' ? first.id
      : (typeof genesis?.name === 'string' ? genesis.name : ''),
    hash,
    contentType: typeof first.mediaType === 'string' ? first.mediaType : undefined,
    version: 1,
  };
}
