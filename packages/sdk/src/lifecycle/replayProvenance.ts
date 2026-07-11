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
 *    The did:btco identifier is satoshi-scoped and the satoshi is only known
 *    post-inscription, so it never lives in the signed migrate data — it can
 *    only be recovered from a `bitcoin-ordinals-2024` witness proof on the
 *    event (mirroring `BtcoCelManager.getCurrentState`, src/cel/layers/
 *    BtcoCelManager.ts ~L374-409). When such a proof IS present, the satoshi
 *    + `data.network` derive `bindings['did:btco']` and the migration's
 *    precise `to`. LifecycleManager.inscribeOnBitcoin's append-first flow
 *    appends the migrate event BEFORE inscription and, post-inscription,
 *    attaches a bitcoin witness proof from the DID-doc inscription (#367) —
 *    so the binding IS derivable in that flow. Whenever no witness proof is
 *    present (degraded flows, legacy logs), `bindings['did:btco']` is
 *    OMITTED and the migration's `to` is the honest sentinel `'did:btco:?'`
 *    rather than a fabricated DID.
 *  - `transfer` → a transfers entry `{ from: data.previousOwner,
 *    to: data.newOwner, timestamp: data.transferredAt, transactionId: data.txid }`.
 *  - `rotateKey` / `update` / `deactivate` → no provenance entries. Key
 *    rotation is custody, not provenance, for this fold.
 *
 * KNOWN, DOCUMENTED DIVERGENCE from the live in-memory caches
 * (`OriginalsAsset.getProvenance()` / `asset.bindings`):
 *  - `bindings['did:btco']` (see above) — absent when the log carries no
 *    bitcoin witness proof (degraded/legacy flows), even though the live
 *    cache always has it (computed from the inscription result directly).
 *  - migrations here are DID-to-DID (`sourceDid` → `targetDid`/derived btco
 *    DID), not the live cache's layer-to-layer labels
 *    (`'did:peer'` → `'did:webvh'`) — a different, complementary shape.
 *  - `commitTxId` / `feeRate` live only in the in-memory ProvenanceChain;
 *    the signed log never carries them (they are not part of the CEL data
 *    Phase 2 signs).
 */
import type { EventLog, LogEntry } from '../cel/types.js';
import { deriveDidCel } from '../cel/celDid.js';
import { btcoDidFromSatoshi } from '../cel/btcoDid.js';

/** Honest sentinel: a btco migration whose satoshi cannot be recovered from the log. */
export const BTCO_SATOSHI_UNKNOWN = 'did:btco:?';

export interface ReplayedProvenance {
  currentLayer: 'did:peer' | 'did:webvh' | 'did:btco';
  bindings: Record<string, string>;
  migrations: Array<{ from: string; to: string; timestamp: string }>;
  transfers: Array<{ from: string; to: string; timestamp: string; transactionId?: string }>;
}

/** Mirrors BtcoCelManager.getCurrentState's witness-proof satoshi extraction. */
function extractWitnessSatoshi(event: LogEntry): string | undefined {
  const proofs = event.proof as ReadonlyArray<unknown> | undefined;
  const bitcoinProof = proofs?.find(
    (p): p is Record<string, unknown> =>
      !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
  );
  const satoshi = bitcoinProof?.satoshi;
  return typeof satoshi === 'string' ? satoshi : undefined;
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
    transfers: [],
  };

  const genesisData = genesis.data as Record<string, unknown>;
  if (typeof genesisData.controller === 'string') {
    result.bindings['did:cel'] = deriveDidCel(log);
  }

  for (let i = 1; i < log.events.length; i++) {
    const event = log.events[i];
    const data = (event.data ?? {}) as Record<string, unknown>;

    if (event.type !== 'migrate' && event.type !== 'transfer') {
      // rotateKey / update / deactivate: rotation is custody, not provenance.
      continue;
    }

    if (event.type === 'migrate' && data.layer === 'webvh') {
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
    } else if (event.type === 'migrate' && data.layer === 'btco') {
      result.currentLayer = 'did:btco';
      const satoshi = extractWitnessSatoshi(event);
      let to = BTCO_SATOSHI_UNKNOWN;
      if (satoshi) {
        const network = typeof data.network === 'string' ? data.network : undefined;
        const btcoDid = btcoDidFromSatoshi(satoshi, network);
        result.bindings['did:btco'] = btcoDid;
        to = btcoDid;
      }
      result.migrations.push({
        from: typeof data.sourceDid === 'string' ? data.sourceDid : '',
        to,
        timestamp: typeof data.migratedAt === 'string' ? data.migratedAt : '',
      });
    } else if (event.type === 'transfer') {
      const txid = data.txid;
      result.transfers.push({
        from: typeof data.previousOwner === 'string' ? data.previousOwner : '',
        to: typeof data.newOwner === 'string' ? data.newOwner : '',
        timestamp: typeof data.transferredAt === 'string' ? data.transferredAt : '',
        ...(typeof txid === 'string' ? { transactionId: txid } : {}),
      });
    }
  }

  return result;
}
