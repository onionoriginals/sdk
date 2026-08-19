/**
 * Durable per-user store for in-flight inscriptions — the stranded-funds fix.
 *
 * A signed commit + reveal pair is persisted here BEFORE anything is
 * broadcast, so a browser tab dying between the commit and reveal broadcasts
 * can never strand the creator's committed funds: the reveal is rebroadcast
 * from this store (POST /api/btc/inscribe/rebroadcast, or the next /me load).
 *
 * Layout mirrors originals-store: one JSON file per user under
 * `<dataDir>/inscriptions/<sub>.json`, namespaced by the JWT `sub` so a user
 * only ever sees their own records.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InscriptionStatus = 'signed' | 'commit_broadcast' | 'reveal_broadcast' | 'confirmed';

export interface InscriptionRecord {
  commitTxId: string;
  revealTxId: string;
  inscriptionId: string;
  /** Broadcast-ready signed commit tx hex — kept for idempotent rebroadcast. */
  signedCommitHex: string;
  /** Broadcast-ready signed reveal tx hex — the recovery artifact. */
  revealTxHex: string;
  /** `${txid}:${vout}` of the funding UTXO the commit spends. */
  fundingOutpoint: string;
  changeAddress: string;
  status: InscriptionStatus;
  /**
   * Set when a rebuilt pair took over this record's funding outpoint after
   * its own commit broadcast failed. The record (and its reveal hex) is kept
   * FOREVER, never deleted: the failed broadcast may have been ambiguous —
   * the commit could still be on the network — and this reveal is then the
   * only way to complete that inscription (rebroadcast by commitTxId).
   */
  superseded?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InscriptionsStore {
  /** Insert a new record (no-op if the same commitTxId already exists). */
  create(subOrgId: string, rec: InscriptionRecord): void;
  /**
   * Mark a record superseded so its funding outpoint can be reused by a
   * rebuilt pair. NEVER deletes: the reveal hex must survive in case the
   * old commit reached the network despite its broadcast call failing.
   */
  supersede(subOrgId: string, commitTxId: string): void;
  /**
   * Clear the superseded flag — used when a superseded pair's commit turns
   * out to have WON its funding outpoint (confirmed on-chain), making it the
   * live record again (the rival pair gets superseded in its place).
   */
  reinstate(subOrgId: string, commitTxId: string): void;
  get(subOrgId: string, commitTxId: string): InscriptionRecord | null;
  setStatus(subOrgId: string, commitTxId: string, status: InscriptionStatus): void;
  list(subOrgId: string): InscriptionRecord[];
  /** The LIVE (non-superseded) record whose commit spends this `${txid}:${vout}` outpoint. */
  findByOutpoint(subOrgId: string, outpoint: string): InscriptionRecord | null;
  /**
   * ALL users' records whose reveal never broadcast (signed/commit_broadcast)
   * and that are older than `olderThanMs` — the monitoring sweep, so stranded
   * states can't silently accumulate. Read-only; acting on them stays with the
   * per-user rebroadcast route.
   */
  sweepStale(olderThanMs: number): Array<{
    subOrgId: string;
    commitTxId: string;
    status: InscriptionStatus;
    createdAt: string;
  }>;
}

/** A subOrgId used as a filename — Turnkey sub-orgs are UUID-safe; reject anything else. */
function subFile(dataDir: string, subOrgId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(subOrgId)) throw new Error('BAD_KEY');
  return join(dataDir, 'inscriptions', `${subOrgId}.json`);
}

export function createInscriptionsStore(opts: {
  dataDir: string;
  maxPerUser?: number;
  now?: () => number;
}): InscriptionsStore {
  const maxPerUser = opts.maxPerUser ?? 200;
  const now = opts.now ?? (() => Date.now());

  function readAll(subOrgId: string): InscriptionRecord[] {
    const path = subFile(opts.dataDir, subOrgId);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as InscriptionRecord[];
  }

  // Atomic write (temp + rename): this file holds the ONLY copy of a signed
  // reveal once the client is gone — a torn write here would destroy exactly
  // the recovery artifact the store exists to protect. rename(2) on the same
  // filesystem replaces the file atomically, so readers see the old complete
  // JSON or the new complete JSON, never a truncated one.
  function writeAll(subOrgId: string, recs: InscriptionRecord[]): void {
    const path = subFile(opts.dataDir, subOrgId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(recs));
    renameSync(tmp, path);
  }

  return {
    create(subOrgId, rec) {
      const recs = readAll(subOrgId);
      if (recs.some((r) => r.commitTxId === rec.commitTxId)) return; // idempotent retry
      if (recs.length >= maxPerUser) throw new Error('STORE_FULL');
      recs.push(rec);
      writeAll(subOrgId, recs);
    },
    supersede(subOrgId, commitTxId) {
      const recs = readAll(subOrgId);
      const rec = recs.find((r) => r.commitTxId === commitTxId);
      if (!rec) throw new Error('NOT_FOUND');
      rec.superseded = true;
      rec.updatedAt = new Date(now()).toISOString();
      writeAll(subOrgId, recs);
    },
    reinstate(subOrgId, commitTxId) {
      const recs = readAll(subOrgId);
      const rec = recs.find((r) => r.commitTxId === commitTxId);
      if (!rec) throw new Error('NOT_FOUND');
      delete rec.superseded;
      rec.updatedAt = new Date(now()).toISOString();
      writeAll(subOrgId, recs);
    },
    get(subOrgId, commitTxId) {
      return readAll(subOrgId).find((r) => r.commitTxId === commitTxId) ?? null;
    },
    setStatus(subOrgId, commitTxId, status) {
      const recs = readAll(subOrgId);
      const rec = recs.find((r) => r.commitTxId === commitTxId);
      if (!rec) throw new Error('NOT_FOUND');
      rec.status = status;
      rec.updatedAt = new Date(now()).toISOString();
      writeAll(subOrgId, recs);
    },
    list(subOrgId) {
      return readAll(subOrgId);
    },
    findByOutpoint(subOrgId, outpoint) {
      return readAll(subOrgId).find((r) => r.fundingOutpoint === outpoint && !r.superseded) ?? null;
    },
    sweepStale(olderThanMs) {
      const dir = join(opts.dataDir, 'inscriptions');
      if (!existsSync(dir)) return [];
      const cutoff = now() - olderThanMs;
      const stale: Array<{ subOrgId: string; commitTxId: string; status: InscriptionStatus; createdAt: string }> = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const subOrgId = file.slice(0, -'.json'.length);
        let recs: InscriptionRecord[];
        try {
          recs = JSON.parse(readFileSync(join(dir, file), 'utf8')) as InscriptionRecord[];
        } catch {
          continue; // a torn write must not kill the sweep
        }
        for (const r of recs) {
          if (r.status !== 'signed' && r.status !== 'commit_broadcast') continue;
          if (Date.parse(r.createdAt) > cutoff) continue;
          stale.push({ subOrgId, commitTxId: r.commitTxId, status: r.status, createdAt: r.createdAt });
        }
      }
      return stale;
    },
  };
}
