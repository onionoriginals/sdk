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
  /**
   * Every `${txid}:${vout}` the commit spends, in input order. `[0]` is the
   * IDENTITY outpoint (its first sat is the did:btco sat). A record CLAIMS all
   * of them: two pairs with overlapping-but-unequal sets would both spend the
   * overlap, and the loser's reveal is stranded.
   */
  fundingOutpoints: string[];
  /**
   * LEGACY single-outpoint shape, still present in records written to the live
   * volume before multi-input funding. Read-only: normalized into
   * `fundingOutpoints` on load, and mirrored on write so an older reader (and
   * the /me response shape) keeps working.
   */
  fundingOutpoint?: string;
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
  /**
   * When the record's STATUS last changed. Deliberately NOT touched by a
   * rebroadcast: the UI decides whether to offer a manual retry from how long
   * a reveal has been stuck at this status, and a server re-push refreshing
   * this would keep that clock permanently reset — the manual escape hatch
   * would never appear. Re-push timing lives in `rebroadcastAt`.
   */
  updatedAt: string;
  /** When the reveal was last re-pushed; the throttle clock, separate from `updatedAt`. */
  rebroadcastAt?: string;
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
  /**
   * Stamp a re-push of an already-broadcast reveal. Touches ONLY
   * `rebroadcastAt` — the status did not change, and `updatedAt` is what the
   * UI's staleness clock reads.
   */
  markRebroadcast(subOrgId: string, commitTxId: string): void;
  list(subOrgId: string): InscriptionRecord[];
  /** The LIVE (non-superseded) record whose commit spends this `${txid}:${vout}` outpoint. */
  findByOutpoint(subOrgId: string, outpoint: string): InscriptionRecord | null;
  /**
   * Every LIVE record claiming ANY of these outpoints — the double-spend gate.
   * A single-outpoint lookup would wave through a second pair whose input set
   * merely OVERLAPS a live one, and both would spend the shared UTXO.
   */
  findByOutpoints(subOrgId: string, outpoints: string[]): InscriptionRecord[];
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
   *
   * Trust-on-first-use, and NOT re-derived from Turnkey: whatever address the
   * client first presents is what gets bound. That makes the bindings file the
   * whole of the enforcement, so an UNREADABLE one throws
   * `BINDINGS_UNREADABLE` rather than resetting to `{}` — silently permitting
   * a rebind is how a corrupt (or tampered) file turns into a deposit address
   * that is not the user's.
   */
  bindDepositAddress(subOrgId: string, network: string, address: string): string;
  /** The already-bound address for (sub, network), or null. Throws on an unreadable file. */
  depositBinding(subOrgId: string, network: string): string | null;
  /** The last deposit read we could trust for this user, or null. */
  lastDepositRead(
    subOrgId: string
  ): { network: string; address: string; confirmedSats: number; at: string } | null;
  /**
   * Every bound deposit address across ALL users — the cross-user reader the
   * balance sweep needs (the only other cross-user scan walks inscriptions).
   * Read-only and network-free: it reports what is on disk, and the caller
   * decides which addresses are worth an indexer read. Each row carries what
   * the drop-out rule is decided from — the last trusted balance and whether
   * anything is still in flight — so the sweep never has to open these files
   * twice.
   */
  listBoundDeposits(): BoundDeposit[];
  /**
   * Remember a read of the deposit address we could TRUST, and clear any
   * standing alert. The confirmed balance is kept so a later outage can still
   * tell the creator what they hold — the number they need to hear is the one
   * from before the indexer went away.
   */
  recordDepositRead(
    subOrgId: string,
    read: { network: string; address: string; confirmedSats: number }
  ): void;
  /**
   * Record that the read behind this user's deposit address could not be
   * trusted (R28). Idempotent per outage: `firstSeenAt` survives repeated
   * polls so the UI can say how long it has been going on.
   */
  recordDepositAlert(
    subOrgId: string,
    alert: { kind: DepositAlertKind; network: string; address: string }
  ): DepositAlert;
  /**
   * The standing alert, or null. This is the R31 delivery path: it is read on
   * the NEXT VISIT (GET /api/btc/inscribe), not only by a tab that happened to
   * still be polling when the outage started.
   */
  getDepositAlert(subOrgId: string): DepositAlert | null;
}

/** One bound deposit address, as the balance sweep sees it. */
export interface BoundDeposit {
  subOrgId: string;
  network: string;
  address: string;
  /** Confirmed sats at the last read we could trust; null when never read. */
  lastConfirmedSats: number | null;
  /** When that read happened; null when never read. */
  lastReadAt: string | null;
  /** Anything still holding recovery artifacts — an inscription in flight. */
  hasPendingInscription: boolean;
}

export type DepositAlertKind = 'indexer_unavailable' | 'indexer_rate_limited';

/** A persisted "your deposit read cannot be trusted" state (R28/R31). */
export interface DepositAlert {
  kind: DepositAlertKind;
  network: string;
  address: string;
  /** Confirmed sats at the address on the last read we could trust (0 if none). */
  heldSats: number;
  firstSeenAt: string;
  updatedAt: string;
}

/** Per-user deposit bookkeeping. Kept in its own file so the address bindings keep their shape. */
interface DepositState {
  lastRead?: { network: string; address: string; confirmedSats: number; at: string };
  alert?: DepositAlert;
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

/**
 * The outpoints a record claims, reading the legacy single-outpoint shape.
 * Exported because the routes reason about claims too (reconciliation,
 * supersede) and must see the same set the store does.
 */
export function outpointsOf(r: InscriptionRecord): string[] {
  if (Array.isArray(r.fundingOutpoints) && r.fundingOutpoints.length > 0) return r.fundingOutpoints;
  return r.fundingOutpoint ? [r.fundingOutpoint] : [];
}

/**
 * Normalize a record read off disk into the current shape. Records written
 * before multi-input funding carry only `fundingOutpoint`; the live volume
 * holds real recovery artifacts in that shape, so they are upgraded on read
 * rather than orphaned.
 */
function normalize(r: InscriptionRecord): InscriptionRecord {
  const outpoints = outpointsOf(r);
  if (r.fundingOutpoints === outpoints && r.fundingOutpoint === outpoints[0]) return r;
  return { ...r, fundingOutpoints: outpoints, fundingOutpoint: outpoints[0] };
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
    return (JSON.parse(readFileSync(path, 'utf8')) as InscriptionRecord[]).map(normalize);
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
    // Persist the rename: fsync the directory (the POSIX idiom — open it
    // read-only and fsync the fd). Gate on the PLATFORM, not on error codes:
    // an error-code allowlist cannot distinguish "this platform cannot fsync
    // a directory" from a genuine permission or I/O failure on a filesystem
    // that supports it (EACCES/EPERM occur as both), and this write precedes
    // a real-BTC broadcast — ambiguity must resolve to failing closed. POSIX
    // platforms (the deployment target) support directory fsync, so EVERY
    // failure there propagates: store.create throws, the route 500s, and the
    // commit is never broadcast against a recovery record that might not
    // survive a crash. Only Windows — where a directory genuinely cannot be
    // opened for fsync — skips this and keeps the rename-only guarantee.
    if (process.platform !== 'win32') {
      const dirFd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  }

  function writeAll(subOrgId: string, recs: InscriptionRecord[]): void {
    writeJson('inscriptions', subOrgId, recs);
  }

  /**
   * The deposit-address bindings for one user. FAIL CLOSED on an unreadable
   * file: these bindings are the entire enforcement behind "this address
   * belongs to this account" (nothing re-derives it from Turnkey), so reading
   * a torn or tampered file as `{}` would silently permit a rebind — a
   * stranger's mainnet BTC pointed at an address that is not theirs. An empty
   * or absent file is a genuine "not bound yet"; unparseable is not.
   */
  function readBindings(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    if (raw.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('BINDINGS_UNREADABLE');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('BINDINGS_UNREADABLE');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v) throw new Error('BINDINGS_UNREADABLE');
      out[k] = v;
    }
    return out;
  }

  /** Per-user deposit bookkeeping; a torn/absent file reads as "nothing known". */
  function readDepositState(subOrgId: string): DepositState {
    const path = subFile(opts.dataDir, 'deposit-state', subOrgId);
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as DepositState;
    } catch {
      return {};
    }
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
      recs.push(normalize(rec));
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
    markRebroadcast(subOrgId, commitTxId) {
      const recs = readAll(subOrgId);
      const rec = recs.find((r) => r.commitTxId === commitTxId);
      if (!rec) throw new Error('NOT_FOUND');
      rec.rebroadcastAt = new Date(now()).toISOString();
      writeAll(subOrgId, recs);
    },
    list(subOrgId) {
      return readAll(subOrgId);
    },
    findByOutpoint(subOrgId, outpoint) {
      return readAll(subOrgId).find((r) => !r.superseded && outpointsOf(r).includes(outpoint)) ?? null;
    },
    findByOutpoints(subOrgId, outpoints) {
      const wanted = new Set(outpoints);
      return readAll(subOrgId).filter((r) => !r.superseded && outpointsOf(r).some((o) => wanted.has(o)));
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
      const bindings = readBindings(subFile(opts.dataDir, 'deposits', subOrgId));
      const existing = bindings[network];
      if (existing) return existing;
      bindings[network] = address;
      writeJson('deposits', subOrgId, bindings);
      return address;
    },
    depositBinding(subOrgId, network) {
      return readBindings(subFile(opts.dataDir, 'deposits', subOrgId))[network] ?? null;
    },
    lastDepositRead(subOrgId) {
      return readDepositState(subOrgId).lastRead ?? null;
    },
    listBoundDeposits() {
      const dir = join(opts.dataDir, 'deposits');
      if (!existsSync(dir)) return [];
      const out: BoundDeposit[] = [];
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.json')) continue;
        const subOrgId = file.slice(0, -'.json'.length);
        let bindings: Record<string, string>;
        try {
          bindings = readBindings(join(dir, file));
        } catch {
          // An unreadable bindings file fails the USER's request closed, but
          // must not blind the sweep to every other stranger's funds.
          continue;
        }
        const state = (() => {
          try {
            return readDepositState(subOrgId);
          } catch {
            return {} as DepositState;
          }
        })();
        let pending = false;
        try {
          pending = readAll(subOrgId).some(isPending);
        } catch {
          pending = false; // a torn inscriptions file must not kill the scan
        }
        for (const [network, address] of Object.entries(bindings)) {
          const read = state.lastRead?.address === address ? state.lastRead : undefined;
          out.push({
            subOrgId,
            network,
            address,
            lastConfirmedSats: read ? read.confirmedSats : null,
            lastReadAt: read ? read.at : null,
            hasPendingInscription: pending,
          });
        }
      }
      return out;
    },
    recordDepositRead(subOrgId, read) {
      const state = readDepositState(subOrgId);
      // A trusted read ENDS the outage — the alert is dropped, not merged.
      // Skip the write when nothing changed: this is the 15s-poll path, and
      // an fsync per poll per creator is real cost for no information.
      const last = state.lastRead;
      if (
        !state.alert &&
        last &&
        last.confirmedSats === read.confirmedSats &&
        last.address === read.address &&
        last.network === read.network
      ) {
        return;
      }
      writeJson('deposit-state', subOrgId, {
        lastRead: { ...read, at: new Date(now()).toISOString() },
      } satisfies DepositState);
    },
    recordDepositAlert(subOrgId, alert) {
      const state = readDepositState(subOrgId);
      const at = new Date(now()).toISOString();
      const existing = state.alert;
      // An ongoing outage is polled every 15s per stuck creator. Re-stamping
      // `updatedAt` on each one costs an fsync for no new information, so an
      // unchanged alert is refreshed at most once a minute.
      if (
        existing &&
        existing.kind === alert.kind &&
        existing.address === alert.address &&
        now() - Date.parse(existing.updatedAt) < 60_000
      ) {
        return existing;
      }
      const next: DepositAlert = {
        kind: alert.kind,
        network: alert.network,
        address: alert.address,
        heldSats: state.lastRead?.address === alert.address ? state.lastRead.confirmedSats : 0,
        // One outage, one clock: repeated polls must not keep resetting it.
        firstSeenAt: existing && existing.address === alert.address ? existing.firstSeenAt : at,
        updatedAt: at,
      };
      writeJson('deposit-state', subOrgId, { ...state, alert: next });
      return next;
    },
    getDepositAlert(subOrgId) {
      return readDepositState(subOrgId).alert ?? null;
    },
  };
}
