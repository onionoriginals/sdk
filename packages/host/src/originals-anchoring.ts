/**
 * Anchoring signed-in authors' Originals on Bitcoin (plan 011, PR 10b),
 * behind `bitcoinAnchoring` (off).
 *
 * The browser signs everything: the author key signs the anchoring entry and
 * every later entry (P5.2, P5.3), and the sat holder's deposit key signs the
 * commit (P9.12). It prepares the pair with the SDK writer, which verifies
 * the log as a fresh reader would first (P9.18). This module is the server
 * half. It keeps, per Original, a durable copy of the log and a durable
 * recovery store, and it is the only place a pair is broadcast:
 *
 * - `submit` imports the author's evidence package (verified; a copy that
 *   diverges from the one held is an unresolved fork and refused, P6.6, S1),
 *   then sends the pair through `submitEntryInscription`. That re-reads the
 *   sat, re-checks the entry is still next, that no other pair for it can
 *   land, that the indexes agree and the sat is still in the pair, verifies
 *   the log through the entry again, and persists before each broadcast
 *   (P9.6, P9.10, P9.18). The pair's own `replaces` is never trusted: only a
 *   replacement this server's `catchUp` calls for is honoured (P9.6).
 * - `status` is `catchUp` over the held copy and recovery store: the
 *   publication label (P9.18), the next action, the three heads and the
 *   ownership report, kept apart (section 7). It never returns transaction
 *   bytes.
 * - `sweep` resumes recorded pairs `catchUp` says to resume, after it
 *   re-verifies them (P9.18). It never prepares a pair: that needs the
 *   holder's signature, so it is the browser's next step.
 *
 * Layout: `<dataDir>/originals-anchoring/<sub>/<sha256(did)>/` holds `did`,
 * `store/` (a FileStore) and `recovery/` (a fileRecoveryStore). Recovery
 * records hold signed spending transactions: the data directory is private.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { OriginalsError } from '@originals/vh';
import { OriginalsSDK, satEvidence, type InscriptionClock } from '@originals/sdk/originals';
import type { SatEvidence } from '@originals/vh/originals';
import { FileStore, fileRecoveryStore } from '@originals/sdk/originals/fs';
import {
  catchUp,
  resumeEntryInscription,
  submitEntryInscription,
  type CatchUpStep,
  type PreparedEntryInscription,
  type SatIndexRead,
} from '@originals/sdk/originals/bitcoin';
import type { OrdinalsProvider } from '@originals/sdk';
import type { MoneyLogger } from './money-log.js';

export interface OriginalsAnchoringDeps {
  dataDir: string;
  /** The node that broadcasts and the index that serves the sat read (P9.11). */
  provider: OrdinalsProvider;
  clock: InscriptionClock;
  /** The name of the index `provider` reads, reported on every read (P9.11). */
  index: string;
  /** Further independent indexes, compared with `provider`'s read (P9.10). */
  indexes?: SatIndexRead[];
  money: MoneyLogger;
  /** Originals the sweep looks at per pass. */
  sweepBudget?: number;
}

export interface AnchoringSubmission {
  did: string;
  /** The author's evidence package (a ZIP) through the entry the pair publishes. */
  evidence: Uint8Array;
  pair: PreparedEntryInscription;
}

/** A refusal or failure, with the status the route answers with. */
export interface AnchoringRefusal {
  ok: false;
  httpStatus: number;
  error: string;
  message: string;
  code?: string;
  category?: string;
  details?: Record<string, unknown>;
}

export interface AnchoringSent {
  ok: true;
  /** `recorded`: this exact pair was already held, so nothing new was sent (P9.6). */
  outcome: 'sent' | 'recorded';
  versionId: string;
  recoveryId: string;
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  broadcast: string;
  /** A broadcast the node refused; the pair is held and resumed by the sweep. */
  error?: string;
}

/** What `status` reports: separate parts, never one verdict (section 7). */
export interface AnchoringStatus {
  did: string;
  sat: string;
  publication: string;
  action: CatchUpStep['action'];
  versionId?: string;
  recoveryId?: string;
  inscriptionId?: string;
  reason?: string;
  replaces?: string[];
  /** `refused` only: what broadcasting the recorded pair would do (P9.18). */
  refused?: { commit: string; ifRevealed: string; code: string; message: string };
  /** `wait-for-evidence` only: the signer DID version this server lacks. */
  signer?: { did: string; versionId: string };
  /** `wait-for-bitcoin` only: what the indexes disagree on (P9.10). */
  disagreement?: { disputed: string[]; holders: string[] };
  heads: { committed: string; accepted: string | null; acceptedHeight: number | null; next: string | null; queue: string[] };
  /** Never true for an Original that is not anchored (P7.10). */
  current: boolean;
  /**
   * Shown with `current`, never dropped (section 7, P9.15; originals-spec #51):
   * `unverifiable-inscriptions` and
   * `publications-waiting` do not stop the accepted state being current, and
   * `listed` names each one, a waiting one with the inscription it waits on.
   */
  notices: string[];
  listed: { unverifiable: Array<{ inscription: string; signer: string; signerVersionId: string }>; waiting: Array<{ inscription: string; waitingOn: string }> };
  /** `wait-for-evidence` on a pair that waits on an earlier unverifiable inscription: that inscription. */
  waitingOn?: string;
  /** The holder of the sat. Ownership is not authority (P9.11, P9.12). */
  ownership: { status: string; output: string; address?: string; confirmations: number; indexes: string[] } | null;
  /** The indexes read, and whether more than one was compared (P9.10, P9.11). */
  indexes: { used: string[]; compared: boolean };
  recoveryIssues: Array<{ recoveryId: string; code: string; message: string }>;
}

const SUB_RE = /^[A-Za-z0-9._-]+$/;
const DID_RE = /^did:vh:[A-Za-z0-9._:%-]+$/;

/** OriginalsError categories (spec section 6) as HTTP statuses. */
function statusFor(category: string): number {
  switch (category) {
    case 'stale-parent': return 409;
    case 'incomplete-evidence': return 503;
    // A sat or block read missing bytes is transient: the browser keeps and resends the pair (P9.6).
    case 'unavailable-bytes': return 503;
    case 'limit-exceeded': return 413;
    default: return 422;
  }
}

export function refusal(error: unknown, fallback: string): AnchoringRefusal {
  if (error instanceof OriginalsError) {
    const details = error.details as Record<string, unknown> | undefined;
    // The report can be large and carries the whole log; the problems name what failed.
    const { report: _report, ...rest } = details ?? {};
    return {
      ok: false, httpStatus: statusFor(error.category), error: fallback, code: error.code, category: error.category, message: error.message,
      ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
    };
  }
  // Not one of the writer's refusals: its message can name server paths, so it stays in the server log.
  console.warn(`[landing] originals anchoring: ${fallback}:`, error);
  return { ok: false, httpStatus: 502, error: fallback, message: 'The writer could not complete this request; nothing was sent.' };
}

/** The shape a browser can send. Anything else is refused before any read. */
function wellFormedPair(pair: unknown): pair is PreparedEntryInscription {
  const p = pair as PreparedEntryInscription | null;
  const prepared = p?.prepared;
  return !!p && typeof p.versionId === 'string' && !!prepared && prepared.version === 1 &&
    typeof prepared.signedCommitHex === 'string' && typeof prepared.revealTxHex === 'string' &&
    typeof prepared.commitTxId === 'string' && typeof prepared.revealTxId === 'string' &&
    typeof prepared.inscriptionId === 'string' && typeof prepared.satoshi === 'string' &&
    typeof prepared.changeAddress === 'string' && Array.isArray(prepared.fundingUtxos) && prepared.fundingUtxos.length > 0;
}

interface Held {
  sdk: OriginalsSDK;
  recoveryStore: ReturnType<typeof fileRecoveryStore>;
}

export function createOriginalsAnchoring(deps: OriginalsAnchoringDeps) {
  const root = join(deps.dataDir, 'originals-anchoring');
  const held = new Map<string, Promise<Held>>();
  const locks = new Map<string, Promise<unknown>>();
  const read = { provider: deps.provider, clock: deps.clock, index: deps.index, ...(deps.indexes ? { indexes: deps.indexes } : {}) };
  const indexesUsed = [deps.index, ...(deps.indexes ?? []).map((i) => i.index)];

  const dirOf = (sub: string, did: string) => {
    if (!SUB_RE.test(sub)) throw new Error('BAD_KEY');
    return join(root, sub, hex.encode(sha256(new TextEncoder().encode(did))));
  };

  /** One copy of the log and one recovery store per Original, opened once per process. */
  function open(dir: string, did: string): Promise<Held> {
    let h = held.get(dir);
    if (!h) {
      h = (async () => {
        await mkdir(join(dir, 'recovery'), { recursive: true });
        await writeFile(join(dir, 'did'), did);
        // No author list: the author's DID history comes in the evidence package and is kept with it.
        const sdk = OriginalsSDK.create({ store: await FileStore.open(join(dir, 'store')), authors: [] });
        return { sdk, recoveryStore: fileRecoveryStore(join(dir, 'recovery')) };
      })();
      h.catch(() => held.delete(dir));
      held.set(dir, h);
    }
    return h;
  }

  /** One writer per Original at a time: submit and sweep never race to broadcast. */
  function exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(dir) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    locks.set(dir, tail);
    void tail.then(() => { if (locks.get(dir) === tail) locks.delete(dir); });
    return run;
  }

  async function known(dir: string): Promise<boolean> {
    try {
      await readFile(join(dir, 'did'));
      return true;
    } catch {
      return false;
    }
  }

  async function submit(sub: string, submission: AnchoringSubmission): Promise<AnchoringSent | AnchoringRefusal> {
    const { did, evidence, pair } = submission;
    if (typeof did !== 'string' || !DID_RE.test(did)) {
      return { ok: false, httpStatus: 400, error: 'bad_request', message: 'An Original (did:vh) is required.' };
    }
    if (!wellFormedPair(pair)) return { ok: false, httpStatus: 400, error: 'bad_request', message: 'A prepared inscription pair is required.' };
    const dir = dirOf(sub, did);
    return exclusive(dir, async () => {
      const { sdk, recoveryStore } = await open(dir, did);

      // The author's copy, verified, kept unless it would roll back or replace ours (P7.5).
      let imported;
      try {
        imported = await sdk.import(evidence);
      } catch (error) {
        deps.money('originals_anchor_refused', { sub, did, reason: 'evidence_not_verified' });
        return refusal(error, 'evidence_not_verified');
      }
      if (imported.original.did !== did) {
        return { ok: false, httpStatus: 422, error: 'evidence_mismatch', message: `The evidence is for ${imported.original.did}, not ${did}.` };
      }
      if (imported.status === 'conflict') {
        // Two valid branches off Bitcoin: no branch is current, and nothing is inscribed for either (P6.6, S1).
        deps.money('originals_anchor_refused', { sub, did, reason: 'original_forked' });
        return { ok: false, httpStatus: 409, error: 'original_forked', message: 'This copy of the Original diverges from the one this server holds. Forks are not settled off Bitcoin, so neither branch is inscribed.' };
      }

      const known = await answerRecorded(recoveryStore, pair);
      if (known) return known;

      // Only the replacement this server's own catch-up calls for (P9.6): never one the browser names.
      let replaces: string[] = [];
      try {
        const step = await catchUp({ sdk, did, ...read, recoveryStore });
        if (step.action === 'prepare' && step.versionId === pair.versionId) replaces = step.replaces;
      } catch (error) {
        return refusal(error, 'not_sendable');
      }

      deps.money('originals_anchor_attempted', { sub, did, versionId: pair.versionId, commitTxId: pair.prepared.commitTxId, inputs: pair.prepared.fundingUtxos.length });
      try {
        const sent = await submitEntryInscription({ sdk, did, pair: { ...pair, replaces: [] }, ...read, provider: deps.provider, recoveryStore, replaces });
        deps.money(sent.error ? 'originals_anchor_broadcast_failed' : 'originals_anchor_broadcast', {
          sub, did, versionId: pair.versionId, commitTxId: sent.commitTxId, revealTxId: sent.revealTxId, broadcast: sent.broadcast, ...(sent.error ? { detail: sent.error } : {}),
        });
        return {
          ok: true, outcome: 'sent', versionId: pair.versionId, recoveryId: sent.recoveryId, inscriptionId: sent.inscriptionId,
          commitTxId: sent.commitTxId, revealTxId: sent.revealTxId, broadcast: sent.broadcast, ...(sent.error ? { error: sent.error } : {}),
        };
      } catch (error) {
        const r = refusal(error, 'not_sendable');
        deps.money('originals_anchor_refused', { sub, did, versionId: pair.versionId, reason: r.code ?? r.error });
        return r;
      }
    });
  }

  /**
   * The same pair again (a lost answer): held already, so answered from its
   * record and never sent again here (P9.6); the sweep resumes it if it still
   * needs sending. Different bytes under the same commit are refused.
   */
  async function answerRecorded(recoveryStore: Held['recoveryStore'], pair: PreparedEntryInscription): Promise<AnchoringSent | AnchoringRefusal | null> {
    const recorded = await recoveryStore.load(pair.prepared.commitTxId).catch(() => undefined);
    if (!recorded) return null;
    if (recorded.prepared.signedCommitHex.toLowerCase() !== pair.prepared.signedCommitHex.toLowerCase() ||
        recorded.prepared.revealTxHex.toLowerCase() !== pair.prepared.revealTxHex.toLowerCase()) {
      return { ok: false, httpStatus: 409, error: 'signed_pair_mismatch', message: 'This commit is already on record with different signed transaction bytes.' };
    }
    return {
      ok: true, outcome: 'recorded', versionId: pair.versionId, recoveryId: recorded.recoveryId, inscriptionId: recorded.prepared.inscriptionId,
      commitTxId: recorded.prepared.commitTxId, revealTxId: recorded.prepared.revealTxId, broadcast: recorded.broadcast,
    };
  }

  /**
   * A pair this server already holds, answered from its record before any
   * check that needs its inputs unspent: by the time a lost answer is retried
   * its commit may be confirmed, and its inputs spent by it. Null otherwise.
   */
  async function recorded(sub: string, did: string, pair: PreparedEntryInscription): Promise<AnchoringSent | AnchoringRefusal | null> {
    if (typeof did !== 'string' || !DID_RE.test(did) || !wellFormedPair(pair)) return null;
    const dir = dirOf(sub, did);
    if (!(await known(dir))) return null;
    return exclusive(dir, async () => answerRecorded((await open(dir, did)).recoveryStore, pair));
  }

  function summarize(did: string, step: CatchUpStep): AnchoringStatus {
    const p = step.pending;
    const ownership = p.view.report.ownership;
    return {
      did,
      sat: p.sat,
      publication: p.publication,
      action: step.action,
      ...('versionId' in step ? { versionId: step.versionId } : {}),
      ...('recoveryId' in step ? { recoveryId: step.recoveryId } : {}),
      ...('inscriptionId' in step ? { inscriptionId: step.inscriptionId } : {}),
      ...('reason' in step ? { reason: step.reason } : {}),
      ...(step.action === 'wait-for-evidence' && step.waitingOn ? { waitingOn: step.waitingOn } : {}),
      ...(step.action === 'prepare' ? { replaces: step.replaces } : {}),
      ...(step.action === 'refused' ? { refused: { commit: step.commit, ifRevealed: step.ifRevealed, code: step.error.code, message: step.error.message } } : {}),
      ...(step.action === 'wait-for-evidence' ? { signer: { did: step.signer, versionId: step.signerVersionId } } : {}),
      ...(step.action === 'wait-for-bitcoin' ? { disagreement: { disputed: step.disputed, holders: step.holders } } : {}),
      heads: { committed: p.committed, accepted: p.accepted, acceptedHeight: p.acceptedHeight, next: p.next, queue: p.queue },
      current: p.view.current,
      notices: [...p.view.report.notices],
      listed: {
        unverifiable: (p.view.report.anchoring?.unverifiable ?? []).map(({ inscription, signer, signerVersionId }) => ({ inscription, signer, signerVersionId })),
        waiting: (p.view.report.anchoring?.ignored ?? []).flatMap((i) => (i.reason === 'waiting-for-earlier-unverifiable' && i.waitingOn ? [{ inscription: i.inscription, waitingOn: i.waitingOn }] : [])),
      },
      ownership: ownership
        ? { status: ownership.status, output: ownership.output, ...(ownership.address ? { address: ownership.address } : {}), confirmations: ownership.confirmations, indexes: ownership.indexes }
        : null,
      indexes: { used: indexesUsed, compared: indexesUsed.length > 1 },
      // Codes only: a store's message can name server paths.
      recoveryIssues: p.recoveryIssues.map(({ recoveryId, code }) => ({ recoveryId, code, message: 'This recovery record could not be used; an operator needs to look at it.' })),
    };
  }

  async function status(sub: string, did: string): Promise<AnchoringStatus | AnchoringRefusal> {
    if (typeof did !== 'string' || !DID_RE.test(did)) return { ok: false, httpStatus: 400, error: 'bad_request', message: 'An Original (did:vh) is required.' };
    const dir = dirOf(sub, did);
    if (!(await known(dir))) return { ok: false, httpStatus: 404, error: 'not_submitted', message: 'This server holds no anchoring of that Original for this account.' };
    return exclusive(dir, async () => {
      const { sdk, recoveryStore } = await open(dir, did);
      try {
        return summarize(did, await catchUp({ sdk, did, ...read, recoveryStore }));
      } catch (error) {
        return refusal(error, 'status_unavailable');
      }
    });
  }

  /** Every Original this server holds, as `[sub, did, dir]`. */
  async function held_(): Promise<Array<[string, string, string]>> {
    const out: Array<[string, string, string]> = [];
    const subs = await readdir(root).catch(() => [] as string[]);
    for (const sub of subs.sort()) {
      if (!SUB_RE.test(sub)) continue;
      const originals = await readdir(join(root, sub)).catch(() => [] as string[]);
      for (const key of originals.sort()) {
        const dir = join(root, sub, key);
        const did = await readFile(join(dir, 'did'), 'utf8').catch(() => null);
        if (did && DID_RE.test(did)) out.push([sub, did, dir]);
      }
    }
    return out;
  }

  let cursor = 0;
  /**
   * Resume what `catchUp` says to resume, re-verified (P9.18). Nothing is
   * prepared here: a new pair needs the holder's signature.
   */
  async function sweep(): Promise<{ examined: number; resumed: number; failed: number }> {
    const all = await held_();
    const budget = Math.max(1, deps.sweepBudget ?? 50);
    let examined = 0, resumed = 0, failed = 0;
    for (let k = 0; k < Math.min(budget, all.length); k++) {
      const [sub, did, dir] = all[(cursor + k) % all.length];
      examined++;
      await exclusive(dir, async () => {
        const { sdk, recoveryStore } = await open(dir, did);
        try {
          const step = await catchUp({ sdk, did, ...read, recoveryStore });
          if (step.action !== 'resume') return;
          const sent = await resumeEntryInscription({ sdk, did, ...read, provider: deps.provider, recoveryStore, recoveryId: step.recoveryId });
          resumed++;
          deps.money(sent.error ? 'originals_anchor_broadcast_failed' : 'originals_anchor_resumed', {
            sub, did, versionId: step.versionId, commitTxId: sent.commitTxId, broadcast: sent.broadcast, ...(sent.error ? { detail: sent.error } : {}),
          });
        } catch (error) {
          failed++;
          deps.money('originals_anchor_sweep_failed', { sub, did, reason: error instanceof OriginalsError ? error.code : error instanceof Error ? error.message : String(error) });
        }
      });
    }
    cursor = all.length > 0 ? (cursor + examined) % all.length : 0;
    return { examined, resumed, failed };
  }

  /**
   * A fresh read of a did:btco alias's sat, as evidence for verifyOriginal: the
   * library judges a durable record's fork against it (P9.16). Ownership depth
   * is not established by this read.
   */
  async function bitcoinEvidence(alias: string): Promise<SatEvidence[]> {
    if (typeof deps.provider.getSatSnapshot !== 'function') throw new Error('no sat reads');
    const snapshot = await deps.provider.getSatSnapshot(alias.slice(alias.lastIndexOf(':') + 1), { bodies: 'originals' });
    return [await satEvidence(snapshot, { clock: deps.clock, index: deps.index, ownerConfirmations: 0 })];
  }

  return { submit, recorded, status, sweep, bitcoinEvidence };
}

export type OriginalsAnchoring = ReturnType<typeof createOriginalsAnchoring>;
