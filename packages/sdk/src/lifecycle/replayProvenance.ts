/**
 * replayProvenance — PURE fold over a CEL event log into a provenance
 * summary. No I/O, no network, no clock: every field comes from the log
 * itself. This is the fold Phase 3's `loadAsset` will use to reconstruct
 * provenance from a persisted log alone (Phase 2 uses it only for the
 * live-cache parity tests below).
 *
 * Fold rules:
 *  - Genesis (`create` with `data.controller`) → `currentLayer: 'did:peer'`,
 *    `bindings['did:cel'] = deriveDidCel(log)`.
 *  - `migrate` with `data.layer === 'webvh'` → `currentLayer: 'did:webvh'`,
 *    `bindings['did:webvh'] = data.targetDid`, and a migrations entry
 *    `{ from: data.sourceDid, to: data.targetDid, timestamp: data.migratedAt }`.
 *  - `migrate` with `data.layer === 'btco'` → `currentLayer: 'did:btco'`.
 *    The anchoring sat is read from the controller-SIGNED `data.to`
 *    (`did:btco:<network>:<sat>`, design 2026-07-13), never the unsigned
 *    `bitcoin-ordinals-2024` witness proof — the witness names a sat but
 *    isn't signed by the controller, so it is not identity-bearing. When
 *    `data.to` parses, it derives `bindings['did:btco']` and the migration's
 *    precise `to`. Whenever `data.to` is absent/unparseable (degraded flows,
 *    legacy logs), `bindings['did:btco']` is OMITTED and the migration's `to`
 *    is the honest sentinel `'did:btco:?'` rather than a fabricated DID.
 *  - `transfer` (legacy, no longer written) → no provenance entries. Ownership
 *    history is the sat's UTXO chain on Bitcoin, not the CEL.
 *  - `rotateKey` / `update` / `deactivate` → no provenance entries. Key
 *    rotation is custody, not provenance, for this fold.
 *
 * KNOWN, DOCUMENTED DIVERGENCE from the live in-memory caches
 * (`OriginalsAsset.getProvenance()` / `asset.bindings`):
 *  - `bindings['did:btco']` (see above) — absent when the signed migrate
 *    event carries no parseable `data.to` (degraded/legacy flows), even
 *    though the live cache always has it (computed from the inscription
 *    result directly).
 *  - migrations here are DID-to-DID (`sourceDid` → `targetDid`/derived btco
 *    DID), not the live cache's layer-to-layer labels
 *    (`'did:peer'` → `'did:webvh'`) — a different, complementary shape.
 *  - `commitTxId` / `feeRate` live only in the in-memory ProvenanceChain;
 *    the signed log never carries them (they are not part of the CEL data
 *    Phase 2 signs).
 */
import type { EventLog } from '../cel/types.js';
import { deriveDidCel } from '../cel/celDid.js';
import { btcoDidFromSatoshi } from '../cel/btcoDid.js';
import { parseSatoshiIdentifier } from '../utils/satoshi-validation.js';

/** Honest sentinel: a btco migration whose satoshi cannot be recovered from the log. */
export const BTCO_SATOSHI_UNKNOWN = 'did:btco:?';

export interface ReplayedProvenance {
  currentLayer: 'did:peer' | 'did:webvh' | 'did:btco';
  bindings: Record<string, string>;
  migrations: Array<{ from: string; to: string; timestamp: string }>;
}

export function replayProvenance(log: EventLog): ReplayedProvenance {
  if (!log || !log.events || log.events.length === 0) {
    throw new Error('Cannot replay provenance from an empty event log');
  }

  const genesis = log.events[0];
  if (genesis.type !== 'create') {
    throw new Error('First event must be a create event');
  }

  const result: ReplayedProvenance = {
    currentLayer: 'did:peer',
    bindings: {},
    migrations: [],
  };

  const genesisData = genesis.data as Record<string, unknown>;
  if (typeof genesisData.controller === 'string') {
    result.bindings['did:cel'] = deriveDidCel(log);
  }

  for (let i = 1; i < log.events.length; i++) {
    const event = log.events[i];
    const data = (event.data ?? {}) as Record<string, unknown>;

    if (event.type !== 'migrate') {
      // transfer (legacy) / rotateKey / update / deactivate: not provenance.
      // Ownership history is the sat's UTXO chain, not the CEL.
      continue;
    }

    if (data.layer === 'webvh') {
      result.currentLayer = 'did:webvh';
      const targetDid = typeof data.targetDid === 'string' ? data.targetDid : '';
      if (targetDid) {
        result.bindings['did:webvh'] = targetDid;
      }
      result.migrations.push({
        from: typeof data.sourceDid === 'string' ? data.sourceDid : '',
        to: targetDid,
        timestamp: typeof data.migratedAt === 'string' ? data.migratedAt : '',
      });
    } else if (data.layer === 'btco') {
      result.currentLayer = 'did:btco';
      // The anchoring sat is the controller-SIGNED did:btco in data.to (design
      // 2026-07-13), never the unsigned witness proof. Absent/unparseable to
      // (degraded/legacy) folds to the honest sentinel.
      let to = BTCO_SATOSHI_UNKNOWN;
      if (typeof data.to === 'string') {
        try {
          const satoshi = String(parseSatoshiIdentifier(data.to));
          const network = typeof data.network === 'string' ? data.network : undefined;
          const btcoDid = btcoDidFromSatoshi(satoshi, network);
          result.bindings['did:btco'] = btcoDid;
          to = btcoDid;
        } catch {
          // unparseable signed anchor → leave the sentinel, omit the binding
        }
      }
      result.migrations.push({
        from: typeof data.sourceDid === 'string' ? data.sourceDid : '',
        to,
        timestamp: typeof data.migratedAt === 'string' ? data.migratedAt : '',
      });
    }
  }

  return result;
}
