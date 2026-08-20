import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { demo } from '../content';
import type { DemoAssetState, DemoEngine } from '../sdk/engine';
import { engineIdentity, ANON_IDENTITY } from '../sdk/engine';
import { btcNetwork, demoTier, type BtcNetworkFlag } from '../sdk/network-flag';
import { useAuth } from '../auth/useAuth';
import type { SigningStatus } from '../auth/turnkey-session';
import { generateArtwork } from '../sdk/artwork';
import { getArtSeed, setArtSeed } from '../sdk/artwork-sync';
import { CelChain } from './CelChain';
import { Pipeline } from './Pipeline';
import { Reveal } from './Reveal';
import './demo.css';

type Phase =
  | 'idle'
  | 'creating'
  | 'created'
  | 'publishing'
  | 'published'
  | 'inscribing'
  | 'inscribed';

/** GET /api/btc/deposit — the creator's own UTXOs + the estimated fee target. */
interface DepositInfo {
  address: string;
  confirmedUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>;
  unconfirmedSats: number;
  estimatedCostSats: number;
}

/**
 * What the SERVER says it speaks, versus the VITE_BTC_NETWORK baked into this
 * bundle at build time. The two are set in different places at different
 * times, and a skew is not cosmetic: it would show a creator a mainnet deposit
 * address on a deploy whose server can never spend from it. 'off' means the
 * Bitcoin routes are not mounted at all (GET /api/btc/network 404s).
 */
type ServerNetwork = 'mainnet' | 'testnet' | 'off';

export async function fetchServerNetwork(
  fetchImpl: typeof fetch = fetch
): Promise<ServerNetwork> {
  try {
    const res = await fetchImpl('/api/btc/network', { credentials: 'same-origin' });
    if (!res.ok) return 'off';
    const body = (await res.json()) as { network?: string };
    return body.network === 'mainnet' ? 'mainnet' : body.network === 'testnet' ? 'testnet' : 'off';
  } catch {
    return 'off';
  }
}

/** The server network a given browser flag REQUIRES. */
export function expectedServerNetwork(flag: 'mainnet' | 'testnet4' | 'off'): ServerNetwork {
  return flag === 'mainnet' ? 'mainnet' : flag === 'testnet4' ? 'testnet' : 'off';
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
export type SigningGate = 'ok' | 'sign-in' | 'reauth';

export function signingGate(opts: {
  authenticated: boolean;
  hasSigningClient: boolean;
  status: SigningStatus;
}): SigningGate {
  if (!opts.authenticated) return 'sign-in';
  return opts.hasSigningClient && opts.status === 'active' ? 'ok' : 'reauth';
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
  if (gate === 'reauth') return status === 'expired' ? demo.session.expiredBody : demo.session.missingBody;
  return network === 'mainnet' ? demo.deposit.signInPrompt : demo.inscribeGate.signInPrompt;
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

export function inscribeStepView(real: boolean): InscribeStepView {
  return real
    ? {
        simulated: false,
        label: demo.steps[2].action,
        pending: demo.steps[2].pending,
        description: demo.steps[2].description,
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
 * Map a failed /api/btc/deposit response onto creator-facing copy (R3/R28).
 * Each named server error is its OWN state, because the route serves nothing
 * derived from a read it could not trust: no address, no UTXOs, no quote. The
 * UI must say which of those it is rather than sit on "checking…" forever, or
 * — worse — keep the last quote on screen as though it were current.
 */
export function depositErrorMessage(body: unknown): string | null {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  switch (error) {
    case 'fee_estimate_unavailable':
      return demo.deposit.feeUnavailable;
    case 'utxo_lookup_failed':
      return demo.deposit.indexerUnavailable;
    // A budget, not an outage — ours or theirs, it reads the same to a creator.
    case 'indexer_rate_limited':
    case 'deposit_user_cap':
      return demo.deposit.indexerBusy;
    default:
      return null;
  }
}

/**
 * The one-line badge beside the deposit heading. Separate from the body copy
 * because the badge is the thing a creator reads at a glance — labelling an
 * indexer outage "Fee estimate unavailable" would name the wrong system, and
 * "which system is down" is exactly what decides whether they wait or act.
 */
export function depositErrorBadge(body: unknown): string | null {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  switch (error) {
    case 'fee_estimate_unavailable':
      return demo.deposit.unavailableBadge;
    case 'utxo_lookup_failed':
      return demo.deposit.readUnavailableBadge;
    case 'indexer_rate_limited':
    case 'deposit_user_cap':
      return demo.deposit.readBusyBadge;
    default:
      return null;
  }
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

// Revising is deliberately NOT a phase: it is authorship AT the current layer,
// repeatable, and never moves the asset on. Modelling it as one would put it in
// the pipeline's step math, where every value would be wrong by a layer.
const phaseToStep: Record<Phase, number> = {
  idle: 0,
  creating: 0,
  created: 1,
  publishing: 1,
  published: 2,
  inscribing: 2,
  inscribed: 3
};

function useEngine(authed: boolean, subOrgId?: string) {
  const engineRef = useRef<DemoEngine | null>(null);
  const loading = useRef<Promise<DemoEngine> | null>(null);

  const getEngine = useCallback(async (): Promise<DemoEngine> => {
    if (engineRef.current) return engineRef.current;
    loading.current ??= import('../sdk/engine').then(({ DemoEngine }) => {
      // The engine registers itself as window.__originalsDemo so skeptics can
      // inspect it from the devtools console. Signed-in ⇒ durable hosting under
      // the user's own per-user slug (subOrgId).
      const engine = new DemoEngine({ authed, subOrgId });
      engineRef.current = engine;
      return engine;
    });
    return loading.current;
  }, [authed, subOrgId]);

  // Drop the current engine so the next run starts from a clean slate —
  // fresh keys, fresh publisher DID, fresh asset.
  const discardEngine = useCallback(() => {
    engineRef.current = null;
    loading.current = null;
  }, []);

  return { getEngine, discardEngine };
}

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const { isAuthenticated, bitcoin, user, signing, reauth, beginReauth } = useAuth();
  const network = btcNetwork();
  // R5: the real Bitcoin path follows AUTH, not the build flag alone. The
  // engine derives its provider from this same value, so an enabled money
  // button and a mock provider can no longer end up on screen together.
  const real = demoTier(network, isAuthenticated).real;
  const inscribeView = inscribeStepView(real);
  const [title, setTitle] = useState(demo.form.defaultTitle);
  const [medium, setMedium] = useState(demo.form.mediums[0]);
  const [nonce, setNonce] = useState(() => getArtSeed().nonce);
  // The artwork is the asset: regenerated live from title/medium/nonce while
  // idle, frozen the moment it's created (its bytes are hashed by the SDK).
  const artwork = useMemo(
    () => generateArtwork(title.trim() || demo.form.defaultTitle, medium, nonce),
    [title, medium, nonce]
  );

  // Keep the hero halo in sync: it renders this exact seed.
  useEffect(() => {
    setArtSeed({ title: title.trim() || demo.form.defaultTitle, medium, nonce });
  }, [title, medium, nonce]);
  // The title/medium/nonce whose artwork is actually committed to the log —
  // what Discard restores to. Divergence is detected from the BYTES, not from
  // these, so any route to new artwork counts as a revision.
  const [committed, setCommitted] = useState<{ title: string; medium: string; nonce: number } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [asset, setAsset] = useState<DemoAssetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'events' | 'provenance' | 'resource'>('events');
  // The pre-deposit / pre-sign gate. Recomputed on every render so a session
  // that dies while the deposit screen is open flips the UI on its own.
  const gate = signingGate({
    authenticated: isAuthenticated,
    hasSigningClient: !!bitcoin,
    status: signing,
  });
  const { getEngine, discardEngine } = useEngine(isAuthenticated, user?.subOrgId);
  const logRef = useRef<HTMLDivElement>(null);

  // Preload the SDK chunk when the demo scrolls near the viewport, so the
  // first click is instant but first paint stays light.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void getEngine();
          io.disconnect();
        }
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [getEngine]);

  const celLog = asset?.celLog ?? [];

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [celLog.length]);

  const run = async (
    from: Phase,
    working: Phase,
    done: Phase,
    action: (engine: DemoEngine) => Promise<DemoAssetState>
  ) => {
    setError(null);
    setPhase(working);
    try {
      const engine = await getEngine();
      const state = await action(engine);
      setAsset(state);
      setPhase(done);
    } catch (err) {
      console.error('[originals-demo]', err);
      setError(demoFailureMessage(err));
      setPhase(from);
    }
  };

  const create = () =>
    run('idle', 'creating', 'created', async (engine) => {
      const state = await engine.create(title.trim() || demo.form.defaultTitle, medium, artwork.svg);
      setCommitted({ title, medium, nonce }); // what's on screen is now what's in the log
      return state;
    });
  // Revising leaves `phase` alone — the asset stays exactly where it was.
  const update = async () => {
    setError(null);
    setUpdating(true);
    try {
      const engine = await getEngine();
      setAsset(await engine.update(title.trim() || demo.form.defaultTitle, medium, artwork.svg));
      setCommitted({ title, medium, nonce });
    } catch (err) {
      console.error('[originals-demo]', err);
      setError(demoFailureMessage(err));
    } finally {
      setUpdating(false);
    }
  };
  const publish = () =>
    run('created', 'publishing', 'published', (engine) => engine.publish());

  // Config-skew guard: resolve the server's network once, before any flow that
  // could show a deposit address. null = not yet known. UNCONDITIONAL (R11):
  // gating this on `real` made the client-off direction invisible — a build
  // with VITE_BTC_NETWORK unset against BTC_NETWORK=mainnet is a mainnet deploy
  // silently serving a mock site, and after U2 an anonymous visitor (never
  // `real`) would not have fetched at all.
  const [serverNetwork, setServerNetwork] = useState<ServerNetwork | null>(null);
  useEffect(() => {
    let live = true;
    void fetchServerNetwork().then((n) => { if (live) setServerNetwork(n); });
    return () => { live = false; };
  }, []);
  const networkSkew = networkSkewDetected(network, serverNetwork);
  // Reported in every direction; only the real path has money to block.
  useEffect(() => {
    if (!networkSkew) return;
    console.warn(
      `[originals-demo] network skew: this build is ${network}, the server is ${serverNetwork}.`
    );
  }, [networkSkew, network, serverNetwork]);
  const networkMismatch = real && networkSkew;

  // Creator-pays deposit state (mainnet): the user's own confirmed UTXOs at
  // their Turnkey-derived address, polled while the inscribe step is live so
  // "deposit detected → confirmed" updates without a reload.
  const [deposit, setDeposit] = useState<DepositInfo | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  // Mirror of depositError readable synchronously inside the inscribe click —
  // state set during that same await would still be stale there, and the
  // fallback message ("send BTC and wait for a confirmation") is the wrong
  // advice when the real problem is that we cannot price the fee at all.
  const depositErrorRef = useRef<string | null>(null);
  // Which system is down, in badge form — see depositErrorBadge.
  const [depositBadge, setDepositBadge] = useState<string | null>(null);
  const fetchDeposit = useCallback(async (): Promise<DepositInfo | null> => {
    if (!bitcoin) return null;
    const res = await fetch(
      `/api/btc/deposit?address=${encodeURIComponent(bitcoin.fundingAddress)}`,
      { credentials: 'same-origin' }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = depositErrorMessage(body);
      depositErrorRef.current = message;
      setDepositError(message);
      setDepositBadge(depositErrorBadge(body));
      // Fee source down: drop the last quote too. A stale number is exactly
      // the "misled about what you can lose" case (R3).
      if (message) setDeposit(null);
      return null;
    }
    depositErrorRef.current = null;
    setDepositError(null);
    setDepositBadge(null);
    const info = (await res.json()) as DepositInfo;
    setDeposit(info);
    return info;
  }, [bitcoin]);
  useEffect(() => {
    if (networkMismatch) return;
    if (network !== 'mainnet' || phase !== 'published' || gate !== 'ok' || !bitcoin) return;
    void fetchDeposit();
    const t = setInterval(() => void fetchDeposit(), 15_000);
    return () => clearInterval(t);
  }, [network, phase, gate, bitcoin, fetchDeposit, networkMismatch]);

  const inscribe = () =>
    run('published', 'inscribing', 'inscribed', async (engine) => {
      // Mock path (no real network enabled): unchanged bare inscribe.
      if (!real) return engine.inscribe();
      // Never build a real-BTC transaction against a server on another chain.
      if (networkMismatch) throw new DemoCopyError(demo.deposit.networkMismatch);
      // Real path: must be signed in AND still able to sign. Checked again
      // here, not just before the deposit — the session can die during the
      // confirmation wait, and the user has already sent BTC by then.
      const blocked = signingGateMessage(gate, network, signing);
      if (blocked || !bitcoin) throw new DemoCopyError(blocked ?? demo.session.missingBody);
      if (network === 'mainnet') {
        // Creator-pays: spend the user's OWN confirmed deposit UTXO. Re-fetch
        // at click time — a 15s-old snapshot must not pick a spent outpoint.
        const info = await fetchDeposit();
        // Fee source down: refuse here rather than telling them to deposit
        // more against a number we no longer have (R3).
        if (!info && depositErrorRef.current) throw new DemoCopyError(depositErrorRef.current);
        const utxo = info?.confirmedUtxos.find((u) => u.value >= info.estimatedCostSats);
        if (!utxo) throw new DemoCopyError(demo.deposit.needed);
        return engine.inscribe({
          funding: {
            fundingUtxo: utxo,
            changeAddress: bitcoin.fundingAddress,
            signingClient: bitcoin.signingClient,
          },
        });
      }
      // testnet4: ask the server faucet to fund the user's address, then
      // inscribe with the user's Turnkey key. 507 surfaces a friendly message.
      const res = await fetch('/api/btc/funding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address: bitcoin.fundingAddress }),
      });
      if (res.status === 507) throw new DemoCopyError(demo.inscribeGate.faucetEmpty);
      if (!res.ok) throw new DemoCopyError(demo.inscribeGate.fundingFailed);
      const { fundingUtxo, changeAddress } = (await res.json()) as {
        fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey: string };
        changeAddress: string;
      };
      return engine.inscribe({
        funding: { fundingUtxo, changeAddress, signingClient: bitcoin.signingClient },
      });
    });

  const reset = () => {
    setPhase('idle');
    setAsset(null);
    setError(null);
    setTab('events');
    setCommitted(null);
    setUpdating(false);
    setNonce(Math.floor(Math.random() * 1e9)); // fresh artwork for the next run
    // Next run gets a fresh engine — fresh keys, fresh DIDs, fresh publisher.
    // window.__originalsDemo keeps pointing at the old engine until the new
    // one constructs and re-registers itself, so the hook is never dangling.
    discardEngine();
    void getEngine();
  };

  // Rebuild from a clean slate whenever the auth identity changes (sign in/out
  // via the modal, no reload). Without this the demo keeps the engine it
  // preloaded, so a user who signs in mid-session would publish through the
  // anonymous ephemeral adapter instead of their durable account. Skip the
  // initial mount (identity unchanged).
  const identity = engineIdentity(isAuthenticated, user?.subOrgId);
  const prevIdentity = useRef(identity);
  const reauthIdentity = reauth.fromSubOrgId ? engineIdentity(true, reauth.fromSubOrgId) : null;
  useEffect(() => {
    const transition = identityTransition(prevIdentity.current, identity, {
      active: reauth.active,
      from: reauthIdentity,
    });
    if (transition === 'none') return;
    prevIdentity.current = identity;
    // A re-authentication cycle keeps the engine and the asset: the creator may
    // already have BTC sitting at a deposit address for THIS Original.
    if (transition === 'preserve') return;
    reset();
    // reset() is a fresh closure each render; identity is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, reauth.active, reauthIdentity]);

  const step = phaseToStep[phase];
  const busy =
    phase === 'creating' || phase === 'publishing' || phase === 'inscribing' || updating;
  // Revisable while the asset is authorable for free — did:cel and did:webvh.
  // Not once inscribed: that append is paid on-chain (see DemoEngine.update).
  const canRevise = phase === 'created' || phase === 'published';
  // Compare the BYTES on screen against the bytes in the log. Retyping the
  // title back to its committed value therefore clears the pending state, and
  // a nonce bump that happened to reproduce the same art would too.
  const pendingRevision = canRevise && !!asset && artwork.svg !== asset.resource.content;
  const discardRevision = () => {
    if (!committed) return;
    setTitle(committed.title);
    setMedium(committed.medium);
    setNonce(committed.nonce);
  };
  // The form is the edit surface once an asset exists: typing a new title
  // regenerates the artwork, which IS the new version. Locked only while an
  // operation is in flight, or once inscribed (that append costs sats).
  const formLocked = busy || phase === 'inscribed';
  const stepActions = [create, publish, inscribe];
  const stepPhases: Phase[][] = [
    ['creating'],
    ['publishing'],
    ['inscribing']
  ];

  return (
    <section className="section demo" id={demo.id} ref={rootRef}>
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{demo.eyebrow}</p>
          <h2>{demo.headline}</h2>
          <p>{demo.subhead}</p>
          <p className="demo-console-hint">
            <svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">
              <path d="m3 4 4 4-4 4M8.5 12H13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {demo.consoleHint}
          </p>
        </Reveal>

        <Reveal>
          <div className="demo-shell card">
            <div className="demo-pipeline">
              {/* A revision works AT the current layer, so hold the pipeline
                  one stage back (step points at the NEXT layer) rather than
                  lighting up the one the asset hasn't moved to. */}
              <Pipeline
                active={updating ? Math.max(step - 1, 0) : busy ? step : step > 2 ? 2 : step}
                busy={busy}
              />
            </div>

            <div className="demo-body">
              <div className="demo-controls">
                <div className="demo-asset" data-layer={asset?.layer ?? 'draft'}>
                  <div className="demo-art">
                    <img src={artwork.dataUri} alt={`Generated artwork for “${title || demo.form.defaultTitle}”`} />
                    {(phase === 'idle' || canRevise) && (
                      <button
                        type="button"
                        className="demo-art-refresh"
                        disabled={updating}
                        onClick={() => setNonce((n) => n + 1)}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M13.3 6.6A5.6 5.6 0 0 0 3.1 5.2M2.7 9.4a5.6 5.6 0 0 0 10.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <path d="M3 2.4v2.9h2.9M13 13.6v-2.9h-2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {phase === 'idle' ? demo.form.regenerate : demo.revise.regenerateAction}
                      </button>
                    )}
                    {pendingRevision && (
                      <span className="demo-art-unsigned">{demo.revise.unsignedBadge}</span>
                    )}
                    <span className="demo-art-badge layer-pill" data-layer={asset?.layer ?? undefined}>
                      <span className="dot" />
                      {asset?.layer ?? 'draft'}
                    </span>
                  </div>
                  <div className="demo-form" data-disabled={formLocked || undefined}>
                    <label className="demo-field">
                      <span>{demo.form.titleLabel}</span>
                      <input
                        type="text"
                        value={title}
                        maxLength={80}
                        placeholder={demo.form.titlePlaceholder}
                        disabled={formLocked}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </label>
                    <label className="demo-field">
                      <span>{demo.form.mediumLabel}</span>
                      <select
                        value={medium}
                        disabled={formLocked}
                        onChange={(e) => setMedium(e.target.value)}
                      >
                        {demo.form.mediums.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <p className="demo-art-hint">{demo.form.artHint}</p>
                  </div>
                </div>

                <ol className="demo-steps">
                  {demo.steps.map((s, i) => {
                    const state =
                      step > i
                        ? 'done'
                        : step === i
                          ? stepPhases[i].includes(phase)
                            ? 'busy'
                            : 'ready'
                          : 'locked';
                    return (
                      <li
                        key={s.id}
                        className="demo-step"
                        data-state={state}
                        data-sim={i === 2 && inscribeView.simulated ? '' : undefined}
                      >
                        <span className="demo-step-marker">
                          {state === 'done' ? (
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <span>{i + 1}</span>
                          )}
                        </span>
                        <div className="demo-step-copy">
                          <div className="demo-step-title">
                            <h3>{s.title}</h3>
                            <span className="layer-pill" data-layer={s.layer}>
                              <span className="dot" />
                              {s.layer}
                            </span>
                            {i === 2 && inscribeView.simulated && (
                              // Stays put in every state, including 'done' —
                              // the signal has to outlive the run it labels.
                              <span className="demo-sim-badge">
                                <span className="dot" aria-hidden="true" />
                                {demo.simulated.badge}
                              </span>
                            )}
                          </div>
                          <p>{i === 2 ? inscribeView.description : s.description}</p>
                          {state !== 'done' && (
                            // Step 3 in the simulated tier runs the SDK's mock
                            // provider for real — completable, not disabled —
                            // so its "this is not Bitcoin" signal is the
                            // treatment and the label, never a dead button.
                            <button
                              type="button"
                              className={i === 2 ? inscribeView.buttonClass : 'btn btn-primary demo-step-btn'}
                              disabled={
                                (state !== 'ready' && state !== 'busy') ||
                                (i === 0 && title.trim().length === 0) ||
                                // Publishing an asset while the preview shows
                                // bytes nothing signed would publish something
                                // other than what's on screen.
                                (i === 1 && (pendingRevision || updating))
                              }
                              data-busy={state === 'busy' || undefined}
                              onClick={stepActions[i]}
                            >
                              {state === 'busy' ? (
                                <>
                                  <span className="demo-spinner" aria-hidden="true" />
                                  {i === 2 ? inscribeView.pending : s.pending}
                                </>
                              ) : i === 2 ? (
                                inscribeView.label
                              ) : (
                                s.action
                              )}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {canRevise && asset && (
                  <div className="demo-revise" data-pending={pendingRevision || undefined}>
                    <div className="demo-revise-head">
                      <h4>{demo.revise.heading}</h4>
                      <span className="demo-revise-version">
                        {demo.revise.versionLabel} <code>v{asset.resource.version}</code>
                      </span>
                    </div>
                    <p className="demo-revise-body">
                      {pendingRevision ? demo.revise.unsignedNote : demo.revise.body}
                    </p>
                    <div className="demo-revise-actions">
                      <button
                        type="button"
                        className="btn btn-primary demo-step-btn"
                        disabled={!pendingRevision || updating}
                        data-busy={updating || undefined}
                        onClick={update}
                      >
                        {updating ? (
                          <>
                            <span className="demo-spinner" aria-hidden="true" />
                            {demo.revise.pending}
                          </>
                        ) : (
                          demo.revise.action
                        )}
                      </button>
                      {pendingRevision && !updating && (
                        <button type="button" className="demo-revise-discard" onClick={discardRevision}>
                          {demo.revise.discard}
                        </button>
                      )}
                    </div>
                    {asset.resource.version > 1 && !pendingRevision && (
                      <p className="demo-revise-note">{demo.revise.committedNote}</p>
                    )}
                  </div>
                )}

                {(phase === 'inscribing' || phase === 'inscribed') && (
                  <p className="demo-revise-locked">{demo.revise.lockedNote}</p>
                )}

                {error && <p className="demo-error" role="alert">{error}</p>}

                {phase === 'published' && inscribeView.simulated && (
                  <p className="demo-inscribe-note demo-sim-note">{demo.simulated.note}</p>
                )}

                {phase === 'published' && real && network !== 'mainnet' && (
                  <p className="demo-inscribe-note">
                    {gate === 'ok'
                      ? demo.inscribeGate.yourKeyNote
                      : signingGateMessage(gate, network, signing)}
                  </p>
                )}

                {phase === 'published' && real && networkMismatch && (
                  <p className="demo-error" role="alert">{demo.deposit.networkMismatch}</p>
                )}

                {phase === 'published' && network === 'mainnet' && !networkMismatch && (
                  gate === 'ok' && bitcoin ? (
                    <div className="demo-deposit">
                      <div className="demo-deposit-head">
                        <strong>{demo.deposit.heading}</strong>
                        <span
                          className="demo-resolved-badge"
                          data-ok={
                            !!deposit &&
                            deposit.confirmedUtxos.some((u) => u.value >= deposit.estimatedCostSats)
                              ? true
                              : undefined
                          }
                        >
                          {depositError
                            ? depositBadge ?? demo.deposit.unavailableBadge
                            : !deposit || (deposit.confirmedUtxos.length === 0 && deposit.unconfirmedSats === 0)
                              ? demo.deposit.waiting
                              : deposit.confirmedUtxos.some((u) => u.value >= deposit.estimatedCostSats)
                                ? demo.deposit.ready
                                : demo.deposit.detected}
                        </span>
                      </div>
                      {deposit && (
                        <p className="demo-inscribe-note">
                          {demo.deposit.sendPrefix}{' '}
                          <code>{deposit.estimatedCostSats.toLocaleString()} sats</code>{' '}
                          {demo.deposit.sendSuffix}
                        </p>
                      )}
                      {deposit ? (
                        <p className="demo-inscribe-note">
                          {demo.deposit.addressLabel}: <code>{bitcoin.fundingAddress}</code>
                        </p>
                      ) : depositError ? (
                        // The one fee source is down, so there is no honest
                        // amount to quote — say that, and show no address.
                        <p className="demo-error" role="alert">{depositError}</p>
                      ) : (
                        // No confirmed handshake with the server yet — showing an
                        // address here is how a creator sends real BTC somewhere
                        // this deploy cannot spend from.
                        <p className="demo-inscribe-note">{demo.deposit.addressPending}</p>
                      )}
                      <p className="demo-inscribe-note">{demo.deposit.nonRefundable}</p>
                      {/* R31: said before they deposit — the one moment we know they are reading. */}
                      <p className="demo-inscribe-note">{demo.deposit.ifSomethingGoesWrong}</p>
                    </div>
                  ) : gate === 'reauth' ? (
                    <div className="demo-deposit">
                      <div className="demo-deposit-head">
                        <strong>{demo.session.expiredHeading}</strong>
                      </div>
                      <p className="demo-error" role="alert">{signingGateMessage(gate, network, signing)}</p>
                      <p className="demo-inscribe-note">{demo.session.preserved}</p>
                      {reauth.active ? (
                        <p className="demo-inscribe-note">{demo.session.reauthPending}</p>
                      ) : (
                        <button type="button" className="demo-reset" onClick={() => void beginReauth()}>
                          {demo.session.reauthCta}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="demo-inscribe-note">{signingGateMessage(gate, network, signing)}</p>
                  )
                )}

                {(phase === 'published' || phase === 'inscribing' || phase === 'inscribed') &&
                  asset?.webvhLogUrl && (
                    <div className="demo-resolved">
                      <div className="demo-resolved-head">
                        <span>{demo.resolved.heading}</span>
                        <span
                          className="demo-resolved-badge"
                          data-ok={asset.webvhResolved || undefined}
                        >
                          {asset.webvhResolved
                            ? demo.resolved.resolvedBadge
                            : demo.resolved.pendingBadge}
                        </span>
                      </div>
                      <a
                        className="demo-resolved-link"
                        href={asset.webvhLogUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {demo.resolved.linkLabel}
                        <code>{asset.webvhLogUrl}</code>
                      </a>
                      <p className="demo-resolved-note">{demo.resolved.note}</p>
                      {/* Anonymous logs live in the in-memory host store, which
                          evicts and expires. Say so here rather than let a later
                          visit hit a bare resolver miss. */}
                      {!isAuthenticated && (
                        <p className="demo-resolved-note">
                          {demo.hosting.temporaryNote}
                        </p>
                      )}
                    </div>
                  )}

                {phase === 'inscribed' && asset && (
                  <div className="demo-done">
                    <p>
                      <strong>{demo.done.lead}</strong> {demo.done.beforeSatoshi}{' '}
                      <code>{asset.inscription?.satoshi}</code> {demo.done.beforeTx}{' '}
                      <code>{asset.inscription?.txid}</code>. {demo.done.after}
                    </p>
                    {asset.inscription?.explorerUrl && (
                      <a
                        className="demo-explorer-link"
                        href={asset.inscription.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {demo.inscribeGate.explorerLabel}
                      </a>
                    )}
                    <button type="button" className="demo-reset" onClick={reset}>
                      {demo.reset}
                    </button>
                  </div>
                )}
              </div>

              <div className="demo-output">
                <div className="demo-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'events'}
                    onClick={() => setTab('events')}
                  >
                    {demo.eventLog.title}
                    {celLog.length > 0 && (
                      <span className="demo-tab-count">{celLog.length}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'provenance'}
                    onClick={() => setTab('provenance')}
                  >
                    {demo.inspector.provenanceTab}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'resource'}
                    onClick={() => setTab('resource')}
                  >
                    {demo.inspector.resourceTab}
                  </button>
                </div>

                {tab === 'events' && (
                  <div className="demo-log-wrap">
                    {celLog.length === 0 ? (
                      <div className="demo-log-zero">
                        <p className="demo-log-zero-title">
                          <span className="demo-log-cursor" aria-hidden="true" />
                          {demo.eventLog.empty}
                        </p>
                        <p className="demo-log-zero-hint">{demo.eventLog.emptyHint}</p>
                        <ul className="demo-log-ghosts" aria-hidden="true">
                          {demo.eventLog.emptyUpcoming.map((type) => (
                            <li key={type}>
                              <span className="demo-log-dot" />
                              <code>{type}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="cel-chain-scroll" ref={logRef}>
                        <CelChain entries={celLog} />
                      </div>
                    )}
                  </div>
                )}

                {tab === 'provenance' && (
                  <div className="demo-json">
                    {asset ? (
                      <>
                        <DidList asset={asset} />
                        <pre>
                          <code>{JSON.stringify(asset.provenance, null, 2)}</code>
                        </pre>
                      </>
                    ) : (
                      <p className="demo-empty">{demo.inspector.emptyState}</p>
                    )}
                  </div>
                )}

                {tab === 'resource' && (
                  <div className="demo-json">
                    {asset ? (
                      <>
                        <div className="demo-resource-head">
                          <img
                            className="demo-resource-thumb"
                            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.resource.content)}`}
                            alt="The asset's artwork resource"
                          />
                          <dl className="demo-kv">
                            <div>
                              <dt>file</dt>
                              <dd>
                                <code>{asset.resource.id} · {asset.resource.contentType}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>version</dt>
                              <dd>
                                <code>v{asset.resource.version}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>sha-256</dt>
                              <dd>
                                <code>{asset.resource.hash}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>credentials</dt>
                              <dd>
                                <code>{asset.credentials} signed</code>
                              </dd>
                            </div>
                          </dl>
                        </div>
                        <pre>
                          <code>{asset.metadata?.content}
{'\n'}{asset.resource.content}</code>
                        </pre>
                      </>
                    ) : (
                      <p className="demo-empty">{demo.inspector.emptyState}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function DidList({ asset }: { asset: DemoAssetState }) {
  const entries: Array<[string, string]> = [['did:cel', asset.did]];
  if (asset.webvhDid) entries.push(['did:webvh', asset.webvhDid]);
  if (asset.btcoDid) entries.push(['did:btco', asset.btcoDid]);
  return (
    <dl className="demo-kv">
      {entries.map(([layer, did]) => (
        <div key={layer}>
          <dt>
            <span className="layer-pill" data-layer={layer}>
              <span className="dot" />
              {layer}
            </span>
          </dt>
          <dd>
            <code title={did}>{did}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}
