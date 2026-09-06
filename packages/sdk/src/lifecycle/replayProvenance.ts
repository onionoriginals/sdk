/**
 * replayProvenance — PURE fold over a CEL event log into a provenance
 * summary. No I/O, no network, no clock: every field comes from the log
 * itself. This is the fold Phase 3's `loadAsset` will use to reconstruct
 * provenance from a persisted log alone (Phase 2 uses it only for the
 * live-cache parity tests below).
 *
 * Fold rules:
 *  - Genesis (`create` with `data.controller`) → `currentLayer: 'did:cel'`,
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
 *  - `rotateKey` / `deactivate` → no provenance entries. Key rotation is
 *    custody, not provenance, for this fold. Resource-shaped `update` events
 *    (`resourceId` + `previousVersionHash` + signed `toHash`, #407) fold into
 *    `resourceUpdates`; generic/migration-ish `update` events do not.
 *
 * KNOWN, DOCUMENTED DIVERGENCE from the live in-memory caches
 * (`OriginalsAsset.getProvenance()` / `asset.bindings`):
 *  - `bindings['did:btco']` (see above) — absent when the signed migrate
 *    event carries no parseable `data.to` (degraded/legacy flows), even
 *    though the live cache always has it (computed from the inscription
 *    result directly).
 *  - migrations here are DID-to-DID (`sourceDid` → `targetDid`/derived btco
 *    DID), not the live cache's layer-to-layer labels
 *    (`'did:cel'` → `'did:webvh'`) — a different, complementary shape.
 *  - `commitTxId` / `feeRate` live only in the in-memory ProvenanceChain;
 *    the signed log never carries them (they are not part of the CEL data
 *    Phase 2 signs).
 */
import type { EventLog } from '@originals/cel';
import { deriveDidCel } from '@originals/cel';
import { parseSatoshiIdentifier } from '@originals/cel';
import { beginCustodyFold, custodyFoldStep } from '@originals/cel';

/** Honest sentinel: a btco migration whose satoshi cannot be recovered from the log. */
export const BTCO_SATOSHI_UNKNOWN = 'did:btco:?';

export interface ReplayedProvenance {
  currentLayer: 'did:cel' | 'did:webvh' | 'did:btco';
  bindings: Record<string, string>;
  migrations: Array<{ from: string; to: string; timestamp: string }>;
  resourceUpdates: Array<{
    resourceId: string;
    // Omitted for foreign/legacy update events that carry no numeric toVersion
    // (folding them as NaN serialized to null, poisoning the interchange shape).
    fromVersion?: number;
    toVersion?: number;
    fromHash: string;
    toHash: string;
    timestamp: string;
    changes?: string;
  }>;
  /**
   * Holder entries (post-anchor updates signed outside the creator lineage),
   * in log order — chain of custody as the log knows it. The fold-level twin
   * of the verifier's holder allowlist: `resourceUpdates` above only ever
   * accepts creator-lineage entries, so a holder-shaped update can never
   * appear as a resource version.
   */
  custody: Array<{ author: string; statement?: string; occurredAt?: string; timestamp: string }>;
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
    currentLayer: 'did:cel',
    bindings: {},
    migrations: [],
    resourceUpdates: [],
    custody: [],
  };

  const genesisData = genesis.data as Record<string, unknown>;
  if (typeof genesisData.controller === 'string') {
    // A signed did:cel genesis binds the derived did:cel identifier.
    result.bindings['did:cel'] = deriveDidCel(log);
  }

  const custodyFold = beginCustodyFold(log.events[0]);

  for (let i = 1; i < log.events.length; i++) {
    const event = log.events[i];
    const data = (event.data ?? {}) as Record<string, unknown>;

    // Holder entries fold into `custody` and NOWHERE else — the inverse
    // assertion for resourceUpdates below: a non-lineage post-anchor update
    // can never appear as a resource version, whatever fields it carries.
    const custodyAction = custodyFoldStep(custodyFold, event, i);
    if (custodyAction === 'ignore') continue;
    if (custodyAction === 'holder') {
      const captured = custodyFold.custody[custodyFold.custody.length - 1];
      const proofs = event.proof as ReadonlyArray<{ created?: unknown; witnessedAt?: unknown }> | undefined;
      const controllerProof = proofs?.find((p) => !(p && typeof p === 'object' && 'witnessedAt' in p));
      result.custody.push({
        author: captured.author,
        ...(captured.statement !== undefined ? { statement: captured.statement } : {}),
        ...(captured.occurredAt !== undefined ? { occurredAt: captured.occurredAt } : {}),
        timestamp: typeof controllerProof?.created === 'string' ? controllerProof.created : '',
      });
      continue;
    }

    if (event.type === 'update') {
      // Resource-update events (resourceId + previousVersionHash) fold into the
      // resource-version history. toHash is the SIGNED field on the event (#407);
      // content is no longer embedded. Generic/migration-ish updates lack these
      // fields and are skipped.
      const resourceId = typeof data.resourceId === 'string' ? data.resourceId : undefined;
      const previousVersionHash = typeof data.previousVersionHash === 'string' ? data.previousVersionHash : undefined;
      // Require a NON-EMPTY toHash: replayProvenance is a public export, so a
      // direct caller must not get an empty-hash resource head folded in (an
      // empty-string toHash is a malformed update — the verifier rejects it too).
      const toHash = typeof data.toHash === 'string' && data.toHash.length > 0 ? data.toHash : undefined;
      if (resourceId && previousVersionHash && toHash !== undefined) {
        const toVersion = typeof data.toVersion === 'number' ? data.toVersion : NaN;
        const proofs = event.proof as ReadonlyArray<{ created?: unknown; witnessedAt?: unknown }> | undefined;
        const controllerProof = proofs?.find((p) => !(p && typeof p === 'object' && 'witnessedAt' in p));
        const timestamp = typeof controllerProof?.created === 'string' ? controllerProof.created : '';
        const entry: ReplayedProvenance['resourceUpdates'][number] = {
          resourceId,
          fromHash: previousVersionHash,
          toHash,
          timestamp,
        };
        // Omit the version fields entirely for foreign logs whose update event
        // carries no numeric toVersion (rather than fold them as NaN → null), or
        // whose toVersion is < 2 (would yield a nonsensical fromVersion:0).
        if (Number.isFinite(toVersion) && toVersion >= 2) {
          entry.fromVersion = toVersion - 1;
          entry.toVersion = toVersion;
        }
        result.resourceUpdates.push(entry);
      }
      continue;
    }

    if (event.type !== 'migrate') {
      // transfer (legacy) / rotateKey / deactivate: not provenance.
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
          // Validate `data.to` is a resolvable did:btco, then use it DIRECTLY:
          // it is the controller-SIGNED authoritative value. Re-deriving from
          // parseSatoshiIdentifier(data.to)+data.network would be a second
          // source of truth that can silently disagree (e.g. `to` names `reg`
          // while `data.network` says mainnet).
          parseSatoshiIdentifier(data.to);
          result.bindings['did:btco'] = data.to;
          to = data.to;
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
