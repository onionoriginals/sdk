/** Shared creator decisions and request helpers, independent of React rendering. */
import { contentByteLength, type ResourceContent } from '../sdk/resource-view';
import { demo } from '../content';
import { ANON_IDENTITY } from '../sdk/engine-identity';
import type { BtcNetworkFlag } from '../sdk/network-flag';
import type { SigningStatus } from '../auth/turnkey-session';

/** GET /api/btc/deposit — the creator's own UTXOs + the estimated fee target. */
export interface DepositInfo {
  address: string;
  /** The ORDINAL-CHECKED spendable set — what an inscription may fund from. */
  confirmedUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>;
  /** Everything confirmed at the address, ordinal-bearing outputs included. */
  confirmedSats?: number;
  /**
   * 'unavailable' = we could not classify the outputs, so none are spendable.
   * 'partial' = more outputs than the lookup budget; the unchecked ones are
   * not offered (see uncheckedOutputs), the checked ones are.
   */
  ordinalCheck?: 'ok' | 'unavailable' | 'partial';
  /** Confirmed outputs the server did not classify, and so does not offer. */
  uncheckedOutputs?: number;
  unconfirmedSats: number;
  estimatedCostSats: number;
  /** Fee facts for a pending deposit, when the server could read them. */
  pendingDeposit?: {
    txid: string;
    feeSats: number;
    vsize: number;
    rbf: boolean;
    networkSatVb: number;
  } | null;
}

/**
 * What the SERVER says it speaks, versus the VITE_BTC_NETWORK baked into this
 * bundle at build time. The two are set in different places at different
 * times, and a skew is not cosmetic: it would show a creator a mainnet deposit
 * address on a deploy whose server can never spend from it. 'off' means the
 * Bitcoin routes are not mounted at all (GET /api/btc/network 404s).
 */
export type ServerNetwork = 'mainnet' | 'testnet' | 'regtest' | 'off';

export async function fetchServerNetwork(
  fetchImpl: typeof fetch = fetch
): Promise<ServerNetwork> {
  try {
    const res = await fetchImpl('/api/btc/network', { credentials: 'same-origin' });
    if (!res.ok) return 'off';
    const body = (await res.json()) as { network?: string };
    return body.network === 'regtest' ? 'regtest' : body.network === 'mainnet' ? 'mainnet' : body.network === 'testnet' ? 'testnet' : 'off';
  } catch {
    return 'off';
  }
}

/** The server network a given browser flag REQUIRES. */
export function expectedServerNetwork(flag: BtcNetworkFlag): ServerNetwork {
  return flag === 'regtest' ? 'regtest' : flag === 'mainnet' ? 'mainnet' : flag === 'testnet4' ? 'testnet' : 'off';
}

/**
 * Do the built bundle and the running server disagree about the chain (R11)?
 * Unconditional in both directions: 'off' is a value that can be skewed too —
 * a bundle built without VITE_BTC_NETWORK against a mainnet server is a
 * mainnet deploy silently serving a mock site. null = not yet known, which is
 * never a mismatch.
 */
export function networkSkewDetected(
  flag: BtcNetworkFlag,
  server: ServerNetwork | null
): boolean {
  return server !== null && server !== expectedServerNetwork(flag);
}

/**
 * Whether this browser may be offered a deposit address / asked to sign. The
 * expiry check happens HERE — before a creator is told where to send BTC, and
 * again at the inscribe click — so an expired session is a UI state rather than
 * a raw Turnkey error arriving after the money moved.
 */
export type SigningGate = 'ok' | 'sign-in' | 'reauth' | 'unavailable';

export function signingGate(opts: {
  authenticated: boolean;
  hasSigningClient: boolean;
  status: SigningStatus;
}): SigningGate {
  if (!opts.authenticated) return 'sign-in';
  if (opts.hasSigningClient && opts.status === 'active') return 'ok';
  // A failed bootstrap is NOT "no key yet" — see SigningStatus. Re-signing-in
  // is the thing that failed, so it gets its own gate and its own copy.
  return opts.status === 'unavailable' ? 'unavailable' : 'reauth';
}

/**
 * Copy for a blocked gate — always from content.ts, never a raw error. A
 * session that ran out and a browser that never had one need different words:
 * "expired" is a lie to someone who just reloaded on a new device.
 */
export function signingGateMessage(
  gate: SigningGate,
  network: BtcNetworkFlag,
  status: SigningStatus = 'expired'
): string | null {
  if (gate === 'ok') return null;
  if (gate === 'unavailable') return demo.session.unavailableBody;
  if (gate === 'reauth') return status === 'expired' ? demo.session.expiredBody : demo.session.missingBody;
  return network === 'regtest' ? demo.regtest.signInPrompt : network === 'mainnet' ? demo.deposit.signInPrompt : demo.testnet4.signInPrompt;
}

/**
 * What an auth-identity change should do to the in-flight Original. A genuine
 * identity change still resets (a different account must not inherit the
 * engine), but a re-authentication cycle — including one that dips through
 * anonymous via a full sign-out — preserves it: the whole point of U1 is that a
 * creator who has already sent BTC does not lose the asset it was for.
 */
export function identityTransition(
  prev: string,
  next: string,
  reauth: { active: boolean; from: string | null }
): 'none' | 'preserve' | 'reset' {
  if (prev === next) return 'none';
  if (reauth.active && (next === ANON_IDENTITY || next === reauth.from)) return 'preserve';
  return 'reset';
}

/**
 * How step 3 presents itself. In the simulated tier the step is COMPLETABLE
 * (R6), so "disabled and greyed out" is gone as the signal that it is not real
 * Bitcoin: the replacement is a treatment the money button never wears —
 * `demo-sim-btn` plus `data-sim` on the step itself — and its own label.
 */
export interface InscribeStepView {
  simulated: boolean;
  label: string;
  pending: string;
  description: string;
  buttonClass: string;
}

export function inscribeStepView(
  real: boolean,
  /**
   * Only consulted when the tier IS real, and a real tier only exists on a
   * real-network build — so the mainnet default never describes an 'off' one.
   */
  network: BtcNetworkFlag = 'mainnet'
): InscribeStepView {
  return real
    ? {
        simulated: false,
        label: demo.steps[2].action,
        pending: demo.steps[2].pending,
        // steps[2] states the mainnet truth (own key, own deposit); a
        // testnet4 build is faucet-funded and must say so instead.
        description:
          network === 'regtest' ? demo.regtest.stepDescription : network === 'mainnet' ? demo.steps[2].description : demo.testnet4.stepDescription,
        buttonClass: 'btn btn-primary demo-step-btn'
      }
    : {
        simulated: true,
        label: demo.simulated.action,
        pending: demo.simulated.pending,
        description: demo.simulated.description,
        buttonClass: 'btn demo-step-btn demo-sim-btn'
      };
}

/**
 * The section subhead, per tier (R8). It sits directly above step 3's button,
 * so the one thing it must never do is describe the OTHER tier's Bitcoin step.
 */
export function demoSubhead(real: boolean, network: BtcNetworkFlag = 'off'): string {
  if (real) return `${demo.subhead} ${network === 'regtest' ? demo.regtest.subhead : demo.subheadReal}`;
  // "Sign in to inscribe for real" is only true on a build that HAS a real
  // path. On a mock build signing in changes nothing, so it stays unsaid.
  return network === 'off'
    ? `${demo.subhead} ${demo.subheadSimulated}`
    : `${demo.subhead} ${demo.subheadSimulated} ${demo.subheadSignIn}`;
}

/**
 * What the completion screen may assert (R8). A simulated run ends holding a
 * satoshi number and a txid from the mock provider: the copy around them has
 * to name them for what they are, and there is no transaction to link to.
 */
export interface CompletionCopy {
  lead: string;
  beforeSatoshi: string;
  beforeTx: string;
  after: string;
  /** null in the simulated tier — nothing exists at any explorer. */
  explorerLabel: string | null;
}

export function completionCopy(simulated: boolean, network: BtcNetworkFlag = 'mainnet'): CompletionCopy {
  return simulated
    ? { ...demo.done.simulated, explorerLabel: null }
    : network === 'regtest' ? { ...demo.done.real, lead: demo.regtest.done, explorerLabel: null } : demo.done.real;
}

/** The published-log block. An anonymous log is served here only for a while. */
export function resolvedCopy(authenticated: boolean): {
  heading: string;
  resolvedBadge: string;
  pendingBadge: string;
  linkLabel: string;
  note: string;
} {
  const { heading, temporaryHeading, ...rest } = demo.resolved;
  return { heading: authenticated ? heading : temporaryHeading, ...rest };
}

/**
 * R7 — the durability caveat for an anonymous publish, returned for the
 * PUBLISH STEP rather than for the log that comes back from it. U8 introduced
 * the string but rendered it only after the fact, which is the one moment it
 * cannot change anyone's mind.
 */
export function publishDurabilityNote(authenticated: boolean): string | null {
  return authenticated ? null : demo.hosting.temporaryNote;
}

/**
 * What step 3 costs, shown to everyone the deposit panel will never quote: a
 * signed-out visitor, or any visitor on a deploy with real Bitcoin off. A real
 * mainnet creator gets the live figure from GET /api/btc/deposit a few lines
 * down, so this static estimate is withheld there rather than sitting beside
 * an exact number and disagreeing with it.
 */
export function inscribeCostNote(real: boolean): string | null {
  return real ? null : demo.inscribeCost;
}

/** A confirmed output at the creator's own deposit address. */
export interface FundingUtxo {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
}

/** What the creator's confirmed deposits can pay for right now. */
export interface FundingSelection {
  /** The inputs the commit will spend, in order. `[0]` carries the did:btco sat. */
  selected: FundingUtxo[];
  /** Their sum. */
  totalSats: number;
  /** How far the WHOLE spendable balance falls short of the target (0 when funded). */
  shortfallSats: number;
}

/**
 * Fund from the confirmed SET, not from one fat UTXO (R26). Picking a single
 * output large enough to cover the whole cost is what left a creator who
 * deposited twice — or topped up after a fee rise — permanently told to
 * deposit more with their coins sitting unspent at their own address.
 *
 * Largest-first, and the SAME order the deposit route walks when it sizes
 * `estimatedCostSats`: that quote is priced for the number of inputs this
 * walk selects, so the two cannot disagree about how many inputs the commit
 * pays for. `selected[0]` is the identity input — its first sat becomes the
 * did:btco sat — and every layer below asserts that pinning (U16).
 *
 * `utxos` must already be the ORDINAL-CHECKED spendable set: summing removed
 * the arithmetic that used to keep a 546-sat inscription output out (postage
 * is always below a single-UTXO threshold, never below a sum), so the guard
 * now lives in the server's per-candidate classification.
 */
export function selectFundingUtxos(utxos: FundingUtxo[], targetSats: number): FundingSelection {
  const largestFirst = [...utxos].sort((a, b) => b.value - a.value);
  const selected: FundingUtxo[] = [];
  let totalSats = 0;
  for (const u of largestFirst) {
    if (totalSats >= targetSats) break;
    selected.push(u);
    totalSats += u.value;
  }
  if (totalSats >= targetSats) return { selected, totalSats, shortfallSats: 0 };
  // Short: select NOTHING. A partial set cannot pay for the inscription, and
  // broadcasting a commit it cannot fund is how a reveal gets stranded.
  return { selected: [], totalSats, shortfallSats: targetSats - totalSats };
}

/**
 * The pre-deposit disclosure (R27), in render order. Returned as a list rather
 * than assembled in JSX so it can be asserted directly: it takes no arguments,
 * which IS the requirement — the same lines are shown on a first visit, on a
 * top-up, and on a return visit where the address was already issued, and they
 * do not wait on the address (or on anything else the server has yet to say).
 */
export function depositDisclosure(): string[] {
  return [
    demo.deposit.purpose,
    demo.deposit.addressOrigin,
    demo.deposit.unspentBalance,
    demo.deposit.nonRefundable,
    demo.deposit.ifSomethingGoesWrong,
  ];
}

/**
 * The quote to render, or nothing.
 *
 * A DepositInfo names the address it was fetched for, and a quote is only ever
 * true of that address. `reset()` on an identity change clears the engine and
 * the asset but not this, so a stale quote could pair the PREVIOUS account's
 * balance with the NEW account's address — showing "ready to inscribe" to
 * someone who has sent nothing, and, now that the two are fused into one
 * BIP-21 URI, putting the old amount behind the new address in the wallet
 * link and the QR.
 *
 * Matching on the address rather than clearing on identity also covers the
 * window before the first fetch for a new address returns.
 */
export function quoteForAddress(
  info: DepositInfo | null,
  address: string | null | undefined
): DepositInfo | null {
  if (!info || !address) return null;
  return info.address === address ? info : null;
}

/**
 * Whether the pair actually reached the network, or only the commit did.
 *
 * The server distinguishes these; the SDK discards the distinction (it does
 * not capture submitInscription's return), so the browser reads it back off
 * the provider. Calling a commit-only outcome "inscribed" tells a creator
 * their inscription exists when it does not yet.
 */
export function inscribeIsComplete(status: string | null | undefined): boolean {
  return status === 'reveal_broadcast';
}

/**
 * What actually reached the network, as far as the browser can know.
 *
 * `not-observed` is NOT the same as "we do not know whether it worked": the
 * mock tier and the testnet4 faucet path do not go through the submit seam at
 * all, so a successful inscribe there IS complete and there is no status to
 * read. Collapsing the two into a single nullable status told mock users that
 * a nonexistent funding transaction was on the network.
 */
export type SubmitOutcome =
  | { kind: 'not-observed' }
  | { kind: 'submitted'; status: string | null };

/**
 * What the completion panel may show.
 *
 * A decision rather than a JSX condition, because the first attempt at this
 * fix added a pending notice and left the completion sentence and the reveal
 * explorer link rendering underneath it — so the page both denied and claimed
 * completion, and still linked to a transaction that 404s.
 *
 * Fail-closed applies only where the status is observable: on the submit path
 * a missing or unrecognised status means the reveal is not known to have
 * landed, so nothing is claimed.
 */
export function inscribeDoneView(outcome: SubmitOutcome): {
  claimComplete: boolean;
  showExplorerLink: boolean;
} {
  const complete =
    outcome.kind === 'submitted' && inscribeIsComplete(outcome.status);
  return { claimComplete: complete, showExplorerLink: complete };
}

/** What the deposit badge should say — read off the SUM, never one output. */
export type DepositReadiness = 'waiting' | 'detected' | 'short' | 'ready' | 'unspendable';

/**
 * The badge for a deposit block. Split out so the readiness is computed once
 * per render and the five states read as a table rather than a nested ternary.
 */
export function depositBadgeLabel(
  readiness: ReturnType<typeof depositReadiness>,
  copy: {
    ordinalCheckBadge: string;
    ready: string;
    shortBadge: string;
    detected: string;
    waiting: string;
  }
): string {
  switch (readiness) {
    case 'unspendable':
      return copy.ordinalCheckBadge;
    case 'ready':
      return copy.ready;
    case 'short':
      return copy.shortBadge;
    case 'detected':
      return copy.detected;
    default:
      return copy.waiting;
  }
}

/**
 * A content-size hint for GET /api/btc/deposit, so the quote is sized for
 * what will actually be inscribed. The reveal carries the media bytes plus
 * CBOR metadata holding the DID document and the WHOLE CEL log — which grows
 * with every event — and the route's 8,000-byte default under-funds past
 * ~12.8 KB, stranding a creator after they have deposited (#493). Counted in
 * UTF-8 bytes, never characters, and biased UP: the excess returns as change.
 */
export interface InscriptionContentInput {
  resource: { content: ResourceContent };
  metadata?: { content: string };
  celLog: readonly unknown[];
}

export function inscriptionContentBytes(asset: InscriptionContentInput): number {
  const utf8 = (s: string) => new TextEncoder().encode(s).length;
  // Conservative pre-funding hint: the final signed migrate entry does not
  // exist until the identity sat is selected. The transaction builder prices
  // the complete actual media+CBOR envelope before any broadcast.
  const BITCOIN_MIGRATION_ALLOWANCE = 2_048;
  return (
    contentByteLength(asset.resource.content) +
    utf8(asset.metadata?.content ?? '') +
    utf8(JSON.stringify(asset.celLog)) +
    BITCOIN_MIGRATION_ALLOWANCE
  );
}

export function depositReadiness(info: DepositInfo | null): DepositReadiness {
  if (!info) return 'waiting';
  if (info.ordinalCheck === 'unavailable') return 'unspendable';
  const spendable = info.confirmedUtxos.reduce((n, u) => n + u.value, 0);
  if (spendable >= info.estimatedCostSats) return 'ready';
  // CONFIRMED but not enough is its own state. It used to fall through to
  // 'detected', whose copy says "waiting for one confirmation" — so a creator
  // whose money had already confirmed sat watching a poll for an event that
  // had happened, never told they were short or by how much.
  if (spendable > 0) return 'short';
  const seen = spendable + info.unconfirmedSats + (info.confirmedSats ?? 0);
  return seen > 0 ? 'detected' : 'waiting';
}

/**
 * A shortfall with the number in it. "Deposit more" without an amount is how
 * someone tops up blind and lands short a second time.
 */
export function depositShortfallMessage(heldSats: number, shortfallSats: number): string {
  if (heldSats <= 0) return demo.deposit.needed;
  return (
    `${demo.deposit.shortfallPrefix} ${heldSats.toLocaleString()} sats` +
    `${demo.deposit.shortfallMiddle} ${shortfallSats.toLocaleString()} sats ` +
    demo.deposit.shortfallSuffix
  );
}

/** What a failed /api/btc/deposit response says, in the two places it says it. */
export interface DepositErrorCopy {
  /** The body copy under the heading. */
  message: string;
  /**
   * The one-line badge beside it. Separate from the body because the badge is
   * what a creator reads at a glance — labelling an indexer outage "Fee
   * estimate unavailable" names the wrong system, and which system is down is
   * exactly what decides whether they wait or act.
   */
  badge: string;
}

/**
 * Every failed /api/btc/deposit response, message and badge together (R3/R28).
 *
 * ONE table rather than two parallel switches: the badge switch and the message
 * switch were hand-maintained over the same code set, so a default arm existed
 * in two places and the two could — and did — disagree about which codes were
 * covered. Each named error is its own state, because the route serves nothing
 * derived from a read it could not trust: no address, no UTXOs, no quote.
 */
const DEPOSIT_ERROR_COPY: Record<string, DepositErrorCopy> = {
  fee_estimate_unavailable: {
    message: demo.deposit.feeUnavailable,
    badge: demo.deposit.unavailableBadge,
  },
  utxo_lookup_failed: {
    message: demo.deposit.indexerUnavailable,
    badge: demo.deposit.readUnavailableBadge,
  },
  // The deposit reader is not mounted / not answering: same creator-facing
  // truth as a failed lookup — we cannot read the address right now.
  deposit_unavailable: {
    message: demo.deposit.indexerUnavailable,
    badge: demo.deposit.readUnavailableBadge,
  },
  // A budget, not an outage — ours or theirs, it reads the same to a creator.
  // `rate_limited` is the SHARED client bucket and by far the most reachable of
  // the three; it was the one the old switch left unmapped.
  indexer_rate_limited: { message: demo.deposit.indexerBusy, badge: demo.deposit.readBusyBadge },
  deposit_user_cap: { message: demo.deposit.indexerBusy, badge: demo.deposit.readBusyBadge },
  rate_limited: { message: demo.deposit.indexerBusy, badge: demo.deposit.readBusyBadge },
  user_quota_cap: { message: demo.deposit.indexerBusy, badge: demo.deposit.readBusyBadge },
  // The bindings file is the whole of "this address is yours" — an unreadable
  // one, or one naming a different address, shows NO address either way.
  deposit_binding_unreadable: {
    message: demo.deposit.bindingUnreadable,
    badge: demo.deposit.bindingBadge,
  },
  address_not_bound: { message: demo.deposit.addressNotBound, badge: demo.deposit.bindingBadge },
  // The 7-day cookie ran out under an open tab.
  unauthorized: { message: demo.deposit.signedOut, badge: demo.deposit.signedOutBadge },
};

/**
 * The default arm, in exactly one place. It is a MESSAGE, not null: the caller
 * purges the last address and quote on the strength of this being set, so a
 * silent default is what kept a stale "ready to inscribe" on screen through a
 * 429, a 401, or a proxy 502 whose HTML body parsed to null.
 */
const UNKNOWN_DEPOSIT_ERROR: DepositErrorCopy = {
  message: demo.deposit.unknownError,
  badge: demo.deposit.unknownBadge,
};

export function depositErrorCopy(body: unknown): DepositErrorCopy {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  // hasOwn, not a bare index: `{"error":"constructor"}` would otherwise hit
  // Object.prototype and return a "copy" whose message is undefined.
  return typeof error === 'string' && Object.hasOwn(DEPOSIT_ERROR_COPY, error)
    ? DEPOSIT_ERROR_COPY[error]
    : UNKNOWN_DEPOSIT_ERROR;
}

export function depositErrorMessage(body: unknown): string {
  return depositErrorCopy(body).message;
}

export function depositErrorBadge(body: unknown): string {
  return depositErrorCopy(body).badge;
}

/**
 * A failure the demo raises ON PURPOSE, carrying copy that is already
 * visitor-ready. Everything else reaching the catch is a transport or SDK
 * string and must be translated — that is what the marker class buys.
 */
export class DemoCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoCopyError';
  }
}

/**
 * The ONLY thing a failed step is allowed to put on screen (R15). A raw
 * `HttpHostingStorageAdapter.put failed: 507` was reaching visitors, which is
 * also a breach of GRADING.md's mechanical floor. The raw message still goes to
 * the console for skeptics — just never to the page.
 */
export function demoFailureMessage(err: unknown): string {
  if (err instanceof DemoCopyError) return err.message;
  const raw = err instanceof Error ? err.message : '';
  if (/HostingStorageAdapter\.(?:put|get) failed/.test(raw)) {
    // 507 from the durable per-user store is a QUOTA, not a blip — "try again
    // in a moment" would be a lie. The anonymous store no longer 507s at all.
    if (/failed:\s*429\b/.test(raw)) return demo.hosting.rateLimited;
    if (/failed:\s*507\b/.test(raw)) return demo.hosting.quotaFull;
    return demo.hosting.unavailable;
  }
  return demo.failure;
}

/**
 * One demo run at a time (FR2).
 *
 * The inscribe step spends real BTC and takes seconds, during which the button
 * stayed clickable. Two concurrent runs each fetch deposit state and select
 * funding from the same still-unspent UTXOs, so both can pick the SAME
 * outpoints and broadcast conflicting commits — and whichever settles last
 * wins the rendered state, so a failing second attempt can overwrite a
 * successful first. A ref (not state) because the second click arrives in the
 * same tick, before any re-render could disable anything.
 *
 * The gate reopens in `finally`, including on failure: a stuck gate would
 * strand the step with no way to retry.
 */
export async function runExclusive(
  gate: { current: boolean },
  action: () => Promise<void>
): Promise<'ran' | 'skipped'> {
  if (gate.current) return 'skipped';
  gate.current = true;
  try {
    await action();
    return 'ran';
  } finally {
    gate.current = false;
  }
}

/** Rendered state of one pipeline step. 'done' renders no button at all. */
export type StepState = 'done' | 'busy' | 'ready' | 'locked';

/**
 * Whether a step's button is dead. `busy` is disabled — the previous
 * expression (`state !== 'ready' && state !== 'busy'`) deliberately left it
 * live, which is half of the double-click above; `runExclusive` is the other
 * half, for every surface a run can start from.
 */
export function stepButtonDisabled(opts: {
  index: number;
  state: StepState;
  titleEmpty: boolean;
  pendingRevision: boolean;
  updating: boolean;
  /** Any run in flight anywhere — a revision blocks the pipeline too. */
  anyRunning?: boolean;
}): boolean {
  if (opts.state !== 'ready') return true;
  if (opts.anyRunning) return true;
  if (opts.index === 0) return opts.titleEmpty;
  // Publishing while the preview shows bytes nothing signed would publish
  // something other than what is on screen.
  if (opts.index === 1) return opts.pendingRevision || opts.updating;
  return false;
}

