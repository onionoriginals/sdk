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
  constructor(public readonly status: number, public readonly body: { error?: string; code?: string; message?: string }) {
    super(body.message ?? body.error ?? `The server answered ${status}`);
    this.name = 'AnchoringSubmitError';
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
}

export interface AnchoringOutbox {
  get(did: string): Promise<OutboxEntry | undefined>;
  put(did: string, entry: OutboxEntry): Promise<void>;
  delete(did: string): Promise<void>;
  list(): Promise<string[]>;
}

export function memoryOutbox(): AnchoringOutbox {
  const entries = new Map<string, OutboxEntry>();
  return {
    list: () => Promise.resolve([...entries.keys()]),
    get: (did) => Promise.resolve(entries.has(did) ? structuredClone(entries.get(did)) : undefined),
    put: (did, entry) => Promise.resolve(void entries.set(did, structuredClone(entry))),
    delete: (did) => Promise.resolve(void entries.delete(did)),
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
 * acknowledgement removes signed transactions; auth, gate and validation
 * errors preserve the identical pair for recovery, never prepare a new one.
 */
async function deliver(transport: AnchoringTransport, outbox: AnchoringOutbox, did: string, entry: OutboxEntry): Promise<SubmitAnswer> {
  const sent = await transport.submit({ did, evidence: base64.decode(entry.evidence), pair: entry.pair });
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
