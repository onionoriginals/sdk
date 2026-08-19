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
 * only ever sees their own records. The deposit-address binding lives beside
 * it under `<dataDir>/deposits/<sub>.json`.
 */
import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type InscriptionStatus = 'signed' | 'commit_broadcast' | 'reveal_broadcast' | 'confirmed';

export interface InscriptionRecord {
  commitTxId: string;
  revealTxId: string;
  inscriptionId: string;
  /**
   * Broadcast-ready signed commit tx hex — kept for idempotent rebroadcast.
   * ABSENT once the record is retired (see `retired`).
   */
  signedCommitHex?: string;
  /**
   * Broadcast-ready signed reveal tx hex — the recovery artifact. ABSENT once
   * the record is retired.
   */
  revealTxHex?: string;
  /** `${txid}:${vout}` of the funding UTXO the commit spends. */
  fundingOutpoint: string;
  changeAddress: string;
  status: InscriptionStatus;
  /**
   * Set when a rebuilt pair took over this record's funding outpoint after
   * its own commit broadcast failed. The record (and its reveal hex) is kept,
   * never deleted: the failed broadcast may have been ambiguous — the commit
   * could still be on the network — and this reveal is then the only way to
   * complete that inscription (rebroadcast by commitTxId).
   */
  superseded?: boolean;
  /**
   * The recovery artifacts have been dropped because the record is TERMINAL:
   * either its own reveal confirmed, or it is a superseded pair whose funding
   * outpoint was won by a record that confirmed (its commit double-spends a
   * confirmed tx and can never land). The row itself is kept forever — /me
   * joins on it to show a confirmed inscription — but it no longer carries
   * broadcastable hex, so it stops counting against the pending cap and stops
   * costing disk. Retiring is the ONLY way hex ever leaves this store.
   */
  retired?: boolean;
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
  /**
   * Drop a TERMINAL record's recovery artifacts (see `retired`). Idempotent;
   * the row stays listed. Never call this on a record that could still land.
   */
  retire(subOrgId: string, commitTxId: string): void;
  get(subOrgId: string, commitTxId: string): InscriptionRecord | null;
  setStatus(subOrgId: string, commitTxId: string, status: InscriptionStatus): void;
  list(subOrgId: string): InscriptionRecord[];
  /** The LIVE (non-superseded) record whose commit spends this `${txid}:${vout}` outpoint. */
  findByOutpoint(subOrgId: string, outpoint: string): InscriptionRecord | null;
  /**
   * ALL users' records that still hold un-landed recovery artifacts and are
   * older than `olderThanMs` — the monitoring sweep, so stranded states can't
   * silently accumulate. Read-only; acting on them stays with the per-user
   * rebroadcast route.
   */
  sweepStale(olderThanMs: number): Array<{
    subOrgId: string;
    commitTxId: string;
    status: InscriptionStatus;
    createdAt: string;
  }>;
  /**
   * Bind this user to ONE deposit address per network (first use wins) and
   * return the bound address. The funding address is deterministic per
   * (sub, network) — a Turnkey BIP-84 path — so binding costs an honest
   * client nothing and stops the deposit route from being a general
   * UTXO-lookup proxy for arbitrary third-party addresses.
   */
  bindDepositAddress(subOrgId: string, network: string, address: string): string;
}

/** A subOrgId used as a filename — Turnkey sub-orgs are UUID-safe; reject anything else. */
function subFile(dataDir: string, dir: string, subOrgId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(subOrgId)) throw new Error('BAD_KEY');
  return join(dataDir, dir, `${subOrgId}.json`);
}

/** A record still carries a broadcastable pair (i.e. it is not terminal). */
function isPending(r: InscriptionRecord): boolean {
  return !r.retired && !!r.revealTxHex;
}

export function createInscriptionsStore(opts: {
  dataDir: string;
  /** Hard ceiling on rows per user (retired rows are evicted oldest-first to make room). */
  maxPerUser?: number;
  /**
   * Ceiling on rows still holding broadcastable hex. This is the real cost
   * bound (each pair can be ~100 KB) and a real signal: 25 unfinished
   * inscriptions means something is broken, not that a creator is busy.
   */
  maxPending?: number;
  now?: () => number;
}): InscriptionsStore {
  const maxPerUser = opts.maxPerUser ?? 1000;
  const maxPending = opts.maxPending ?? 25;
  const now = opts.now ?? (() => Date.now());

  function readAll(subOrgId: string): InscriptionRecord[] {
    const path = subFile(opts.dataDir, 'inscriptions', subOrgId);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as InscriptionRecord[];
  }

  // Atomic AND durable write (write → fsync → rename → fsync dir): this file
  // holds the ONLY copy of a signed reveal once the client is gone — losing it
  // destroys exactly the recovery artifact the store exists to protect, and
  // the caller broadcasts the commit (spends real BTC) the moment this
  // returns. rename(2) on the same filesystem is atomic against a PROCESS
  // crash, but a HOST crash can still lose it: without fsync the data blocks
  // and the rename can sit in the page cache when power dies, leaving an
  // empty or vanished file after reboot. So the temp file is fsynced before
  // the rename (contents reach stable storage first) and the containing
  // directory is fsynced after (the rename itself reaches stable storage) —
  // only then is it safe for the caller to broadcast.
  function writeJson(dir: string, subOrgId: string, value: unknown): void {
    const path = subFile(opts.dataDir, dir, subOrgId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // Persist the rename: fsync the directory. Opening a directory read-only
    // for fsync is the POSIX idiom; on platforms where it is not supported
    // (e.g. Windows) this degrades to the pre-fsync behavior rather than
    // failing the write.
    try {
      const dirFd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync unavailable — best-effort platform degradation.
    }
  }

  function writeAll(subOrgId: string, recs: InscriptionRecord[]): void {
    writeJson('inscriptions', subOrgId, recs);
  }

  /** Drop the hex payloads in place. Caller writes. */
  function retireInPlace(rec: InscriptionRecord): void {
    delete rec.signedCommitHex;
    delete rec.revealTxHex;
    rec.retired = true;
    rec.updatedAt = new Date(now()).toISOString();
  }

  return {
    create(subOrgId, rec) {
      const recs = readAll(subOrgId);
      if (recs.some((r) => r.commitTxId === rec.commitTxId)) return; // idempotent retry
      if (recs.filter(isPending).length >= maxPending) throw new Error('STORE_FULL');
      // Retired rows are just join keys for /me; evict the oldest of them
      // rather than locking the user out of inscribing forever.
      if (recs.length >= maxPerUser) {
        const evictable = recs
          .filter((r) => !isPending(r))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const drop = new Set(evictable.slice(0, recs.length - maxPerUser + 1).map((r) => r.commitTxId));
        if (drop.size === 0) throw new Error('STORE_FULL');
        for (let i = recs.length - 1; i >= 0; i--) if (drop.has(recs[i].commitTxId)) recs.splice(i, 1);
      }
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
    retire(subOrgId, commitTxId) {
      const recs = readAll(subOrgId);
      const rec = recs.find((r) => r.commitTxId === commitTxId);
      if (!rec) throw new Error('NOT_FOUND');
      if (rec.retired) return;
      retireInPlace(rec);
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
      // Confirmed is terminal: the pair landed, so the hex is dead weight.
      if (status === 'confirmed') retireInPlace(rec);
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
          // Anything still holding hex is un-landed money: a never-broadcast
          // commit, a commit whose reveal never went out, OR a reveal that
          // went out and never confirmed (evicted from the mempool through a
          // fee spike). All three are stranded states worth a human's eyes.
          if (!isPending(r)) continue;
          if (Date.parse(r.createdAt) > cutoff) continue;
          stale.push({ subOrgId, commitTxId: r.commitTxId, status: r.status, createdAt: r.createdAt });
        }
      }
      return stale;
    },
    bindDepositAddress(subOrgId, network, address) {
      const path = subFile(opts.dataDir, 'deposits', subOrgId);
      let bindings: Record<string, string> = {};
      if (existsSync(path)) {
        try {
          bindings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
        } catch {
          bindings = {}; // a torn write costs a rebind, never an outage
        }
      }
      const existing = bindings[network];
      if (existing) return existing;
      bindings[network] = address;
      writeJson('deposits', subOrgId, bindings);
      return address;
    },
  };
}
