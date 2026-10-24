/**
 * The browser half of anchoring an Original on Bitcoin (plan 011, PR 10b),
 * behind `bitcoinAnchoring` (off).
 *
 * Two keys sign, both client-authorized through the Turnkey session in this
 * browser; the server signs nothing:
 * - the author key (`#key-1`, assertionMethod) signs the anchoring entry and
 *   every later entry (P5.2, P5.3);
 * - the sat holder's deposit key signs the commit, every input of it: the
 *   input holding the sat and the fee inputs. Holding the sat gives no
 *   authority over the log (P9.11, P9.12).
 * The reveal is signed by the SDK's ephemeral key.
 *
 * `publishNextEntry` prepares the pair with the SDK writer, which verifies the
 * log through the entry as a fresh reader would (P9.18) and signs, then hands
 * it to the server, which checks again, persists and broadcasts. Before that
 * hand-off nothing has been sent: cancelling, or a session that expires, costs
 * nothing. The prepared pair sits in an outbox until the server answers, so
 * a lost answer is retried with the identical pair, never a new one (P9.6).
 * `recoveryStore: null` is deliberate here (`inFlightGuard: "skipped"`): the
 * server's recovery store is the one that guards against a second pair.
 */
import { base64 } from '@scure/base';
import { OriginalsError } from '@originals/vh';
import { InscriptionClock, type OriginalsSDK } from '@originals/sdk/originals';
import { prepareEntryInscription, type PreparedEntryInscription, type OffChainEvidence } from '@originals/sdk/originals/bitcoin';
import type { BitcoinSigner, OrdinalsProvider, Utxo } from '@originals/sdk';

/** What the server's status route reports (server/originals-anchoring.ts), parts kept apart (section 7). */
export interface AnchoringStatus {
  did: string;
  sat: string;
  publication: 'anchored' | 'pending-bitcoin-acceptance' | 'submitted-unobserved' | 'not-anchored' | 'unverified';
  action: 'prepare' | 'resume' | 'wait-for-confirmation' | 'wait-for-evidence' | 'wait-for-bitcoin' | 'refused' | 'done';
  versionId?: string;
  recoveryId?: string;
  inscriptionId?: string;
  reason?: string;
  replaces?: string[];
  refused?: { commit: string; ifRevealed: string; code: string; message: string };
  signer?: { did: string; versionId: string };
  disagreement?: { disputed: string[]; holders: string[] };
  heads: { committed: string; accepted: string | null; acceptedHeight: number | null; next: string | null; queue: string[] };
  current: boolean;
  /** Shown with `current`, never dropped (section 7, P9.15): unverifiable inscriptions, and publications waiting on them. */
  notices: Array<'unverifiable-inscriptions' | 'publications-waiting'>;
  listed: { unverifiable: Array<{ inscription: string; signer: string; signerVersionId: string }>; waiting: Array<{ inscription: string; waitingOn: string }> };
  /** `wait-for-evidence` only: the earlier unverifiable inscription this pair waits on. */
  waitingOn?: string;
  ownership: { status: string; output: string; address?: string; confirmations: number; indexes: string[] } | null;
  indexes: { used: string[]; compared: boolean };
  recoveryIssues: Array<{ recoveryId: string; code: string; message: string }>;
  /** The output holding the sat, when it is at this account's address: the next inscription's input 0. */
  satUtxo: { txid: string; vout: number; value: number } | null;
  heldByThisAccount: boolean | null;
}

/** The server's answer to a submitted pair. */
export interface SubmitAnswer {
  outcome: 'sent' | 'recorded';
  versionId: string;
  recoveryId: string;
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  broadcast: string;
  error?: string;
}

/** Everything anchoring needs from the network, all through this site's own server. */
export interface AnchoringTransport {
  provider: Pick<OrdinalsProvider, 'getSatSnapshot' | 'getFirstSatOfOutput' | 'getTransactionStatus' | 'estimateFee'>;
  /** The inscription time at a block (P9.15), from the server's clock; refuses an orphaned block by hash. */
  inscriptionTime(height: number, hash?: string): Promise<number>;
  submit(body: { did: string; evidence: Uint8Array; pair: PreparedEntryInscription }): Promise<SubmitAnswer>;
  status(did: string): Promise<AnchoringStatus>;
}

/** The server refused, or could not take, a pair. The outbox stays until acknowledged. */
export class AnchoringSubmitError extends Error {
  constructor(public readonly status: number, public readonly body: { error?: string; code?: string; category?: string; message?: string }) {
    super(body.message ?? body.error ?? `The server answered ${status}`);
    this.name = 'AnchoringSubmitError';
  }
}

/** Why the server refused a pair itself, kept beside the pair (owner decision, 23 October 2026). */
export interface PairRefusal {
  status: number;
  /** The route's error, e.g. `original_forked` or `not_sendable`. */
  error?: string;
  /** The writer's code when it gave one (e.g. `SAT_MOVED`), else the route's error. */
  code: string;
  /** The spec section 6 category when the writer gave one. */
  category?: string;
  message: string;
  at: string;
}

/**
 * Answers that may still be followed by acceptance, or that say nothing about
 * this pair: the pair is kept unchanged and sent again (P9.6).
 */
const KEEP_STATUSES = new Set([401, 404, 408, 429]);
/**
 * Categories and codes that are about the moment, not the pair: missing or
 * lagging Bitcoin reads, evidence that may arrive later, a pair still in
 * flight, an outpoint an index has not caught up with, an address binding
 * that may be repaired. Kept and resent (decision A, 23 October 2026).
 */
const KEEP_CATEGORIES = new Set(['unavailable-bytes', 'incomplete-evidence']);
const KEEP_CODES = new Set(['SAT_READ_INCOMPLETE', 'BLOCK_TIME_UNAVAILABLE', 'funding_input_spent', 'PAIR_IN_FLIGHT', 'HEAD_NOT_NEXT', 'address_not_bound']);
/**
 * Refusals the same signed bytes can never pass: marked refused and kept for
 * recovery, never resent (decision A, 23 October 2026). Anything not named
 * here or above is kept and resent: an unknown answer loses nothing.
 */
const REFUSED_CODES = new Set([
  'original_forked', 'signed_pair_mismatch', 'SAT_MOVED', 'sat_not_first', 'payload_too_large', 'INSCRIPTION_TOO_LARGE',
  'bad_request', 'evidence_not_verified', 'commit_fee_excessive', 'commit_change_omitted',
  // Round-2 decision: the writer's and route's other permanent codes.
  'ANCHORING_LOG_TOO_LARGE', 'WRONG_SAT', 'HANDOFF_SAT_MISMATCH', 'PAIR_BODY_MISMATCH', 'NETWORK_MISMATCH',
  'NOTHING_TO_INSCRIBE', 'ENTRY_NOT_STORED', 'evidence_mismatch',
]);

/**
 * A kept pair that gets the same unknown code-bearing 4xx this many times in
 * a row is marked refused, so an unknown permanent code cannot leave it stuck
 * with no way to abandon it (round-2 decision; P9.6).
 */
export const UNKNOWN_REFUSAL_LIMIT = 3;

/** How an answer is treated: refused now, an unknown code-bearing 4xx (counted), or kept. */
function classify(error: unknown): 'refused' | 'unknown' | 'keep' {
  if (!(error instanceof AnchoringSubmitError)) return 'keep';
  if (KEEP_STATUSES.has(error.status) || error.status >= 500 || error.status < 400) return 'keep';
  const { error: routeError, code, category } = error.body;
  if ((category && KEEP_CATEGORIES.has(category)) || [routeError, code].some((c) => c !== undefined && KEEP_CODES.has(c))) return 'keep';
  if ([routeError, code].some((c) => c !== undefined && REFUSED_CODES.has(c))) return 'refused';
  return routeError !== undefined || code !== undefined ? 'unknown' : 'keep';
}

/**
 * True only for a refusal of this pair itself, judged by the server's
 * category and codes, not its HTTP status alone. 401, 404, 408, 429, 5xx,
 * network errors, transient categories and codes, and unknown codes are not.
 */
export function isPairRefusal(error: unknown): error is AnchoringSubmitError {
  return classify(error) === 'refused';
}

const answerCode = (e: AnchoringSubmitError) => `${e.status}:${e.body.code ?? e.body.error ?? ''}`;

/**
 * The server refused this pair (for example `original_forked`,
 * `signed_pair_mismatch`, `SAT_MOVED`, `bad_request`). The pair is kept,
 * marked refused, and not sent again; the user can abandon it explicitly and
 * prepare a new one (P9.6).
 */
export class AnchoringRefusedError extends Error {
  constructor(public readonly refusal: PairRefusal) {
    super(`The server refused this submission: ${refusal.message} Its signed transactions are kept for recovery and will not be sent again. Abandon it to prepare a new one.`);
    this.name = 'AnchoringRefusedError';
  }
}

/** Cancelled before the pair reached the server: nothing was broadcast, nothing spent. */
export class AnchoringCancelledError extends Error {
  constructor() {
    super('Cancelled. Nothing was sent to Bitcoin and nothing was spent.');
    this.name = 'AnchoringCancelledError';
  }
}

/** The signing session ran out. Signing in again and retrying picks up where this stopped. */
export class SigningSessionExpiredError extends Error {
  constructor() {
    super('Your signing session expired. Sign in again to continue; nothing was sent.');
    this.name = 'SigningSessionExpiredError';
  }
}

/** Turnkey's ways of saying the session's API key expired (see withTokenExpiration in @originals/auth). */
export function isSessionExpiry(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SigningSessionExpiredError || (current as { name?: string }).name === 'TurnkeySessionExpiredError') return true;
    const code = (current as { code?: unknown }).code;
    if (code === 16 || code === '16') return true;
    const text = String((current as { message?: unknown }).message ?? '').toLowerCase();
    if (text.includes('api_key_expired') || text.includes('expired api key')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A signing step run under the session guard: refused before it starts when
 * the session is no longer usable or the user cancelled, and a Turnkey expiry
 * from inside it becomes SigningSessionExpiredError.
 */
export async function guardedSign<T>(guard: SigningGuard, fn: () => Promise<T>): Promise<T> {
  guard.check();
  try {
    return await fn();
  } catch (error) {
    if (isSessionExpiry(error)) throw new SigningSessionExpiredError();
    throw error;
  }
}

export interface SigningGuard {
  /** Before a signature: throws AnchoringCancelledError or SigningSessionExpiredError. */
  check(): void;
  /** Before the hand-off: throws AnchoringCancelledError only (a session that ends after signing costs nothing). */
  checkCancelled(): void;
}

export function signingGuard(opts: { signal?: AbortSignal; sessionActive?: () => boolean }): SigningGuard {
  const checkCancelled = () => {
    if (opts.signal?.aborted) throw new AnchoringCancelledError();
  };
  return {
    checkCancelled,
    check() {
      checkCancelled();
      if (opts.sessionActive && !opts.sessionActive()) throw new SigningSessionExpiredError();
    },
  };
}

/** A pair handed to the server whose answer has not come back, kept until it does (P9.6). */
export interface OutboxEntry {
  pair: PreparedEntryInscription;
  /** The evidence package, base64. */
  evidence: string;
  savedAt: string;
  /** Set when the server refused this pair itself: kept for recovery, never resent automatically. */
  refused?: PairRefusal;
  /** The same unknown code-bearing 4xx answered in a row, counted toward UNKNOWN_REFUSAL_LIMIT. */
  strikes?: { answer: string; count: number };
}

export interface AnchoringOutbox {
  get(did: string): Promise<OutboxEntry | undefined>;
  put(did: string, entry: OutboxEntry): Promise<void>;
  delete(did: string): Promise<void>;
  /**
   * Read and, only when `when` holds, delete, as one step (one IDB readwrite
   * transaction): `absent`, `deleted`, or `kept` when the entry did not match.
   */
  deleteIf(did: string, when: (entry: OutboxEntry) => boolean): Promise<'absent' | 'deleted' | 'kept'>;
  /**
   * Replace the entry with `next` only while it still holds the pair whose
   * commit is `commitTxId`, as one step (one IDB readwrite transaction): a
   * newer pair another tab put meanwhile is never overwritten (P9.6).
   */
  replaceIf(did: string, commitTxId: string, next: OutboxEntry): Promise<'absent' | 'replaced' | 'kept'>;
  list(): Promise<string[]>;
}

export function memoryOutbox(): AnchoringOutbox {
  const entries = new Map<string, OutboxEntry>();
  return {
    list: () => Promise.resolve([...entries.keys()]),
    get: (did) => Promise.resolve(entries.has(did) ? structuredClone(entries.get(did)) : undefined),
    put: (did, entry) => Promise.resolve(void entries.set(did, structuredClone(entry))),
    delete: (did) => Promise.resolve(void entries.delete(did)),
    deleteIf: (did, when) => {
      const found = entries.get(did);
      if (!found) return Promise.resolve('absent');
      if (!when(structuredClone(found))) return Promise.resolve('kept');
      entries.delete(did);
      return Promise.resolve('deleted');
    },
    replaceIf: (did, commitTxId, next) => {
      const found = entries.get(did);
      if (!found) return Promise.resolve('absent');
      if (found.pair.prepared.commitTxId !== commitTxId) return Promise.resolve('kept');
      entries.set(did, structuredClone(next));
      return Promise.resolve('replaced');
    },
  };
}

/**
 * The outbox in IndexedDB, so a reload does not lose a pair the server may
 * already hold. It holds signed spending transactions for this browser's own
 * account; they spend only to that account's own address.
 */
export function indexedDbOutbox(name = 'originals-anchoring-outbox'): AnchoringOutbox {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('pairs');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const tx = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction('pairs', mode);
        const request = fn(t.objectStore('pairs'));
        t.oncomplete = () => resolve(request.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    list: async () => (await tx('readonly', (s) => s.getAllKeys())).filter((k): k is string => typeof k === 'string'),
    get: (did) => tx('readonly', (s) => s.get(did) as IDBRequest<OutboxEntry | undefined>),
    put: async (did, entry) => void (await tx('readwrite', (s) => s.put(entry, did))),
    delete: async (did) => void (await tx('readwrite', (s) => s.delete(did))),
    deleteIf: async (did, when) => {
      const db = await open();
      try {
        // The read and the conditional delete share one readwrite transaction, across tabs too.
        return await new Promise<'absent' | 'deleted' | 'kept'>((resolve, reject) => {
          const t = db.transaction('pairs', 'readwrite');
          const store = t.objectStore('pairs');
          let outcome: 'absent' | 'deleted' | 'kept' = 'absent';
          const read = store.get(did);
          read.onsuccess = () => {
            const found = read.result as OutboxEntry | undefined;
            if (!found) return;
            try {
              if (when(found)) { store.delete(did); outcome = 'deleted'; } else outcome = 'kept';
            } catch (error) { t.abort(); reject(error); }
          };
          t.oncomplete = () => resolve(outcome);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      } finally {
        db.close();
      }
    },
    replaceIf: async (did, commitTxId, next) => {
      const db = await open();
      try {
        return await new Promise<'absent' | 'replaced' | 'kept'>((resolve, reject) => {
          const t = db.transaction('pairs', 'readwrite');
          const store = t.objectStore('pairs');
          let outcome: 'absent' | 'replaced' | 'kept' = 'absent';
          const read = store.get(did);
          read.onsuccess = () => {
            const found = read.result as OutboxEntry | undefined;
            if (!found) return;
            if (found.pair.prepared.commitTxId !== commitTxId) { outcome = 'kept'; return; }
            store.put(next, did);
            outcome = 'replaced';
          };
          t.oncomplete = () => resolve(outcome);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

/** This site's own routes (server/bitcoin.ts). */
export function httpAnchoringTransport(opts: { baseUrl?: string; fetchImpl?: typeof fetch; provider: AnchoringTransport['provider'] }): AnchoringTransport {
  const base = opts.baseUrl ?? '';
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const answer = async <T>(res: Response): Promise<T> => {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AnchoringSubmitError(res.status, body as { error?: string; code?: string; message?: string });
    return body as T;
  };
  return {
    provider: opts.provider,
    inscriptionTime: async (height, hash) => {
      const res = await f(`${base}/api/btc/inscription-time?height=${height}${hash ? `&hash=${hash}` : ''}`, { credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as { time?: number; category?: string; code?: string; message?: string };
      // The clock's own refusal, as the SDK raises it, so the writer treats it the same way.
      if (!res.ok && body.code && body.category) throw new OriginalsError(body.category as ConstructorParameters<typeof OriginalsError>[0], body.code, body.message ?? body.code);
      if (!res.ok || typeof body.time !== 'number') throw new AnchoringSubmitError(res.status, body);
      return body.time;
    },
    submit: async ({ did, evidence, pair }) =>
      answer(await f(`${base}/api/btc/originals/submit`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did, evidence: base64.encode(evidence), pair }),
      })),
    status: async (did) => answer(await f(`${base}/api/btc/originals/status?did=${encodeURIComponent(did)}`, { credentials: 'same-origin' })),
  };
}

/**
 * A later refusal says nothing about an earlier lost answer (P9.6). Only an
 * acknowledgement, or the user's explicit abandon of a refused pair, removes
 * signed transactions. Auth, gate, rate, server and network errors preserve
 * the identical pair to send again. A refusal of the pair itself marks it
 * refused and keeps it (owner decision, 23 October 2026); nothing prepares a
 * new pair while it is there.
 */
async function deliver(transport: AnchoringTransport, outbox: AnchoringOutbox, did: string, entry: OutboxEntry): Promise<SubmitAnswer> {
  if (entry.refused) throw new AnchoringRefusedError(entry.refused);
  let sent: SubmitAnswer;
  try {
    sent = await transport.submit({ did, evidence: base64.decode(entry.evidence), pair: entry.pair });
  } catch (error) {
    const kind = classify(error);
    if (kind !== 'refused') {
      if (kind === 'unknown') {
        const answer = answerCode(error as AnchoringSubmitError);
        const count = entry.strikes?.answer === answer ? entry.strikes.count + 1 : 1;
        if (count < UNKNOWN_REFUSAL_LIMIT) { await outbox.replaceIf(did, entry.pair.prepared.commitTxId, { ...entry, strikes: { answer, count } }); throw error; }
      } else {
        // Any other answer breaks the row; the pair itself is untouched (P9.6).
        if (entry.strikes) { const { strikes: _strikes, ...rest } = entry; await outbox.replaceIf(did, entry.pair.prepared.commitTxId, rest); }
        throw error;
      }
    }
    if (!(error instanceof AnchoringSubmitError)) throw error;
    const { strikes: _strikes, ...kept } = entry;
    const refused: PairRefusal = {
      status: error.status,
      ...(error.body.error ? { error: error.body.error } : {}),
      code: error.body.code ?? error.body.error ?? `http_${error.status}`,
      ...(error.body.category ? { category: error.body.category } : {}),
      message: error.body.message ?? `The server answered ${error.status}${error.body.error ? ` (${error.body.error})` : ''}.`,
      at: new Date().toISOString(),
    };
    // Only over this same pair: a newer pair another tab put meanwhile stays as it is (P9.6).
    await outbox.replaceIf(did, entry.pair.prepared.commitTxId, { ...kept, refused });
    throw new AnchoringRefusedError(refused);
  }
  if (sent.commitTxId !== entry.pair.prepared.commitTxId || sent.revealTxId !== entry.pair.prepared.revealTxId || sent.versionId !== entry.pair.versionId) {
    throw new Error('The server did not acknowledge the saved submission. It has been kept for recovery.');
  }
  await outbox.delete(did);
  return sent;
}

export interface PublishNextParams {
  sdk: OriginalsSDK;
  did: string;
  network: 'mainnet' | 'regtest';
  transport: AnchoringTransport;
  outbox: AnchoringOutbox;
  /** Signs the whole commit: the sat input first, then the fee inputs. */
  satSigner: BitcoinSigner;
  /** The account's bound deposit address: change and the sat's next output go here. */
  changeAddress: string;
  /** Input 0 holds the sat at offset 0; the rest pay fees and carry no inscriptions. */
  fundingUtxos: Utxo[];
  feeRate: number;
  /** Which index serves the sat reads (P9.11). */
  index: string;
  guard: SigningGuard;
}

export interface PublishNextResult {
  sent: SubmitAnswer;
  /** The pair as prepared, or the outbox's when an earlier one was resent. */
  pair: PreparedEntryInscription;
  offChain: OffChainEvidence;
  /** True when this resent a pair whose answer was lost, rather than preparing one. */
  resent: boolean;
}

/** Send again, identical, a pair whose answer was lost; null when none is waiting (P9.6). */
export async function resendWaiting(transport: AnchoringTransport, outbox: AnchoringOutbox, did: string): Promise<PublishNextResult | null> {
  const waiting = await outbox.get(did);
  if (!waiting) return null;
  const sent = await deliver(transport, outbox, did, waiting);
  return { sent, pair: waiting.pair, offChain: waiting.pair.offChain, resent: true };
}

/**
 * The user's explicit abandon of a pair the server refused: deletes it so a
 * new one can be prepared. A pair that is not marked refused may still be
 * accepted, so it is never abandoned here (P9.6).
 */
export async function abandonRefused(outbox: AnchoringOutbox, did: string): Promise<boolean> {
  // One step, so a pair another tab replaced since the user looked is never deleted.
  const outcome = await outbox.deleteIf(did, (entry) => !!entry.refused);
  if (outcome === 'kept') throw new Error('Only a submission the server refused can be abandoned. This one may still be accepted, so it has been kept.');
  return outcome === 'deleted';
}

/**
 * An InscriptionClock that asks the server's clock (P9.15) instead of walking
 * every header from genesis through it: one request per inscription height,
 * not one per block of the chain.
 */
class ServerInscriptionClock extends InscriptionClock {
  constructor(private readonly transport: AnchoringTransport) {
    super(() => Promise.reject(new Error('the server answers inscription times')));
  }
  override at(height: number, hash?: string): Promise<number> {
    return this.transport.inscriptionTime(height, hash);
  }
}

function serverClock(transport: AnchoringTransport): InscriptionClock {
  return new ServerInscriptionClock(transport);
}

/** Publish the next entry Bitcoin can accept on the Original's sat (P9.13, P9.17). */
export async function publishNextEntry(p: PublishNextParams): Promise<PublishNextResult> {
  // A pair whose answer was lost goes again, identical: never a second pair for it (P9.6).
  const resent = await resendWaiting(p.transport, p.outbox, p.did);
  if (resent) return resent;
  p.guard.check();
  const satSigner: BitcoinSigner = {
    signAndFinalizeCommitPsbt: (psbt) => guardedSign(p.guard, () => p.satSigner.signAndFinalizeCommitPsbt(psbt)),
  };
  const pair = await prepareEntryInscription({
    sdk: p.sdk, did: p.did, fundingUtxos: p.fundingUtxos, satSigner, changeAddress: p.changeAddress, feeRate: p.feeRate, network: p.network,
    provider: p.transport.provider as OrdinalsProvider, clock: serverClock(p.transport), index: p.index,
    recoveryStore: null,
  });
  // Signed but not sent: a cancel here discards it, and nothing was spent.
  p.guard.checkCancelled();
  const entry: OutboxEntry = { pair, evidence: base64.encode((await p.sdk.package(p.did)).bytes), savedAt: new Date().toISOString() };
  await p.outbox.put(p.did, entry);
  const sent = await deliver(p.transport, p.outbox, p.did, entry);
  return { sent, pair, offChain: pair.offChain, resent: false };
}
