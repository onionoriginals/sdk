import { contentByteLength, contentText, resourceDataUrl, resourceMatchesSource, type ResourceContent } from '../sdk/resource-view';
import { MAX_SOURCE_BYTES, readAssetFile, SourceFileError } from '../sdk/source-file';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DepositPanel } from './DepositPanel';
import { DepositFeeNotice } from './DepositFeeNotice';
import { explorerTxUrl } from '../sdk/explorer';
import { demo } from '../content';
import type { DemoAssetState, DemoEngine } from '../sdk/engine';
import { engineIdentity } from '../sdk/engine';
import { btcNetwork, demoTier, btcoExplorerUrl } from '../sdk/network-flag';
import { useAuth } from '../auth/useAuth';
import { generateArtwork, generateName, ART_STYLES } from '../sdk/artwork';
import type { AssetSource } from '../sdk/engine';
import { getArtSeed, setArtSeed } from '../sdk/artwork-sync';
import { CelChain } from './CelChain';
import { Pipeline } from './Pipeline';
import { Reveal } from './Reveal';
import {
  type DepositInfo,
  type ServerNetwork,
  fetchServerNetwork,
  networkSkewDetected,
  signingGate,
  signingGateMessage,
  identityTransition,
  inscribeStepView,
  demoSubhead,
  completionCopy,
  resolvedCopy,
  publishDurabilityNote,
  inscribeCostNote,
  selectFundingUtxos,
  depositDisclosure,
  quoteForAddress,
  type SubmitOutcome,
  inscribeDoneView,
  depositBadgeLabel,
  inscriptionContentBytes,
  depositReadiness,
  depositShortfallMessage,
  depositErrorCopy,
  DemoCopyError,
  demoFailureMessage,
  runExclusive,
  stepButtonDisabled
} from './demo-logic';
import './demo.css';

type Phase =
  | 'idle'
  | 'creating'
  | 'created'
  | 'publishing'
  | 'published'
  | 'inscribing'
  | 'inscribed';

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

/**
 * The upload ceiling. Inscription pays by the byte — witness data is roughly a
 * vbyte per four bytes — so 32 KB is about 8,000 vB, a cost a visitor can
 * actually cover. A larger cap would let someone build an asset they can never
 * afford to put on Bitcoin, which is a dead end on the money path.
 */


/**
 * The published length, in BYTES. `String.length` counts UTF-16 code units, so
 * it under-counts every emoji and CJK character — the bytes that get hashed and
 * paid for on-chain are UTF-8, and that is what the cap has to measure.
 */
const byteLength = contentByteLength;

/** What was committed to the log, including WHICH source produced it. */
interface CommittedSource {
  title: string;
  style: string;
  nonce: number;
  sourceKind: 'generate' | 'upload' | 'write';
  uploaded: { name: string; content: ResourceContent; contentType: string } | null;
  written: string;
}

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const { isAuthenticated, bitcoin, user, signing, signingNotice, reauth, beginReauth } = useAuth();
  const network = btcNetwork();
  // R5: the real Bitcoin path follows AUTH, not the build flag alone. The
  // engine derives its provider from this same value, so an enabled money
  // button and a mock provider can no longer end up on screen together.
  const real = demoTier(network, isAuthenticated).real;
  const inscribeView = inscribeStepView(real, network);
  // Every tier-dependent string, resolved once from the same `real` /
  // `isAuthenticated` values the behavior is driven by, so copy and behavior
  // cannot drift apart (KTD9).
  const done = completionCopy(inscribeView.simulated, network);
  const resolved = resolvedCopy(isAuthenticated);
  const durabilityNote = publishDurabilityNote(isAuthenticated);
  const costNote = inscribeCostNote(real);
  const [title, setTitle] = useState(demo.form.defaultTitle);
  const [style, setStyle] = useState<string>(getArtSeed().style);
  // Where the asset's bytes come from. Generated artwork is the default; a
  // visitor can bring PNG, SVG or text bytes through the same lifecycle.
  const [sourceKind, setSourceKind] = useState<'generate' | 'upload' | 'write'>('generate');
  const [uploaded, setUploaded] = useState<{ name: string; content: ResourceContent; contentType: string } | null>(null);
  const [written, setWritten] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(() => getArtSeed().nonce);
  // The artwork is the asset: regenerated live from title/style/nonce while
  // idle, frozen the moment it's created (its bytes are hashed by the SDK).
  const artwork = useMemo(
    () => generateArtwork(title.trim() || demo.form.defaultTitle, style, nonce),
    [title, style, nonce]
  );

  // Keep the hero halo in sync: it renders this exact seed.
  useEffect(() => {
    setArtSeed({ title: title.trim() || demo.form.defaultTitle, style, nonce });
  }, [title, style, nonce]);

  // The asset's actual bytes — whichever source is selected.
  const source = useMemo<AssetSource>(() => {
    if (sourceKind === 'upload' && uploaded) {
      return { content: uploaded.content, contentType: uploaded.contentType, filename: uploaded.name };
    }
    if (sourceKind === 'write') {
      // Bare `text/plain`, no charset parameter: the SDK's resource validator
      // accepts `type/subtype` only and refuses media-type parameters.
      return { content: written, contentType: 'text/plain', filename: 'asset.txt' };
    }
    return { content: artwork.svg, contentType: 'image/svg+xml', filename: 'artwork.svg' };
  }, [sourceKind, uploaded, written, artwork]);

  /**
   * A new name comes with new art, and only then.
   *
   * The title counts as "still generated" while it equals what this exact
   * (style, nonce) would have produced — so no separate dirty flag is needed,
   * and a title the visitor typed is never overwritten. Discard and Start over
   * restore a previous pair and land back in the generated state on their own.
   */
  const renameWithArt = (nextStyle: string, nextNonce: number) => {
    if (title === generateName(style, nonce)) setTitle(generateName(nextStyle, nextNonce));
  };

  const sourceIsImage = source.contentType.startsWith('image/');
  const sourceBytes = byteLength(source.content);
  // Measured on the FINAL bytes, whatever produced them. Checking only at
  // upload time missed the Write tab entirely, where multibyte text can pass a
  // code-unit limit and still exceed the cap that is actually charged for.
  const sourceTooBig = sourceBytes > MAX_SOURCE_BYTES;
  // Empty bytes are refused rather than hashed: an asset with nothing in it can
  // be created, but it proves nothing, and the wording says so.
  const sourceReady = (source.content instanceof Uint8Array ? sourceBytes > 0 : source.content.trim().length > 0) && !sourceTooBig;

  const onPickFile = async (file: File | undefined) => {
    setSourceError(null);
    if (!file) return;
    try {
      const source = await readAssetFile(file);
      setUploaded({ name: source.filename, content: source.content, contentType: source.contentType });
    } catch (error) {
      const reason = error instanceof SourceFileError ? error.reason : 'wrong-type';
      setSourceError(reason === 'too-big' ? demo.form.uploadTooBig : reason === 'empty' ? demo.form.uploadEmpty : demo.form.uploadWrongType);
    }
  };
  // The title/style/nonce whose artwork is actually committed to the log —
  // what Discard restores to. Divergence is detected from the BYTES, not from
  // these, so any route to new artwork counts as a revision.
  const [committed, setCommitted] = useState<CommittedSource | null>(null);
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

  // FR2: a second invocation is a no-op regardless of which surface fired it —
  // the money button, the revise button, or a double-click on either.
  const runningRef = useRef(false);
  const run = async (
    from: Phase,
    working: Phase,
    done: Phase,
    action: (engine: DemoEngine) => Promise<DemoAssetState>
  ) => {
    await runExclusive(runningRef, async () => {
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
    });
  };

  const create = () => {
    // Refuse to hash nothing. An empty upload or a blank textarea would mint a
    // genesis whose resource proves nothing, which is worse than a refusal.
    if (sourceTooBig) {
      setSourceError(demo.form.uploadTooBig);
      return;
    }
    if (!sourceReady) {
      setSourceError(sourceKind === 'write' ? demo.form.writeEmpty : demo.form.uploadEmpty);
      return;
    }
    return run('idle', 'creating', 'created', async (engine) => {
      const state = await engine.create(title.trim() || demo.form.defaultTitle, style, source);
      setCommitted({ title, style, nonce, sourceKind, uploaded, written }); // on screen == in the log
      return state;
    });
  };
  // Revising leaves `phase` alone — the asset stays exactly where it was.
  const update = async () => {
    // A revision can grow past the cap just as a genesis can — the Write box is
    // still editable after create, so the same byte gate applies here.
    if (sourceTooBig) {
      setSourceError(demo.form.uploadTooBig);
      return;
    }
    if (!sourceReady) {
      setSourceError(sourceKind === 'write' ? demo.form.writeEmpty : demo.form.uploadEmpty);
      return;
    }
    // Same gate as the pipeline steps: a revision and a publish must not both
    // be appending to the log at once.
    await runExclusive(runningRef, async () => {
      setError(null);
      setUpdating(true);
      try {
        const engine = await getEngine();
        setAsset(await engine.update(title.trim() || demo.form.defaultTitle, style, source));
        setCommitted({ title, style, nonce, sourceKind, uploaded, written });
      } catch (err) {
        console.error('[originals-demo]', err);
        setError(demoFailureMessage(err));
      } finally {
        setUpdating(false);
      }
    });
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
  const [depositRaw, setDeposit] = useState<DepositInfo | null>(null);
  // True when the submit reached the server but only the COMMIT propagated.
  const [submitOutcome, setSubmitOutcome] = useState<SubmitOutcome>({ kind: 'not-observed' });
  const [depositError, setDepositError] = useState<string | null>(null);
  // Mirror of depositError readable synchronously inside the inscribe click —
  // state set during that same await would still be stale there, and the
  // fallback message ("send BTC and wait for a confirmation") is the wrong
  // advice when the real problem is that we cannot price the fee at all.
  const depositErrorRef = useRef<string | null>(null);
  // Which system is down, in badge form — see depositErrorCopy.
  const [depositBadge, setDepositBadge] = useState<string | null>(null);
  // Computed once per render: the badge below reads it four times.
  // Never render a quote belonging to another address (see quoteForAddress).
  const deposit = quoteForAddress(depositRaw, bitcoin?.fundingAddress);
  const readiness = depositReadiness(deposit);
  const fetchDeposit = useCallback(async (): Promise<DepositInfo | null> => {
    if (!bitcoin) return null;
    const hint = asset ? `&contentBytes=${inscriptionContentBytes(asset)}` : '';
    const res = await fetch(
      `/api/btc/deposit?address=${encodeURIComponent(bitcoin.fundingAddress)}${hint}`,
      { credentials: 'same-origin' }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const copy = depositErrorCopy(body);
      depositErrorRef.current = copy.message;
      setDepositError(copy.message);
      setDepositBadge(copy.badge);
      // UNCONDITIONAL: whatever went wrong, the last address and quote are no
      // longer things we can stand behind. Keeping them is exactly the "misled
      // about what you can lose" case (R3), and gating the purge on a mapped
      // message is what let an unmapped 429 leave a green badge on screen.
      setDeposit(null);
      return null;
    }
    depositErrorRef.current = null;
    setDepositError(null);
    setDepositBadge(null);
    const info = (await res.json()) as DepositInfo;
    setDeposit(info);
    return info;
  }, [bitcoin, asset]);
  useEffect(() => {
    if (networkMismatch) return;
    if ((network !== 'mainnet' && network !== 'regtest') || phase !== 'published' || gate !== 'ok' || !bitcoin) return;
    void fetchDeposit();
    const t = setInterval(() => void fetchDeposit(), 15_000);
    return () => clearInterval(t);
  }, [network, phase, gate, bitcoin, fetchDeposit, networkMismatch]);

  const inscribe = () =>
    run('published', 'inscribing', 'inscribed', async (engine) => {
      setSubmitOutcome({ kind: 'not-observed' });
      // Mock path (no real network enabled): unchanged bare inscribe.
      if (!real) return engine.inscribe();
      // Never build a real-BTC transaction against a server on another chain.
      if (networkMismatch) throw new DemoCopyError(demo.deposit.networkMismatch);
      // Real path: must be signed in AND still able to sign. Checked again
      // here, not just before the deposit — the session can die during the
      // confirmation wait, and the user has already sent BTC by then.
      const blocked = signingGateMessage(gate, network, signing);
      if (blocked || !bitcoin) throw new DemoCopyError(blocked ?? demo.session.missingBody);
      if (network === 'mainnet' || network === 'regtest') {
        // Creator-pays: spend the user's OWN confirmed deposit UTXO. Re-fetch
        // at click time — a 15s-old snapshot must not pick a spent outpoint.
        const info = await fetchDeposit();
        // Fee source down: refuse here rather than telling them to deposit
        // more against a number we no longer have (R3).
        if (!info && depositErrorRef.current) throw new DemoCopyError(depositErrorRef.current);
        if (!info) throw new DemoCopyError(demo.deposit.needed);
        // Unclassified coins are not spendable coins: an inscribed sat burned
        // as a fee is destroyed, and we would be the ones who burned it.
        if (info.ordinalCheck === 'unavailable') {
          throw new DemoCopyError(demo.deposit.ordinalCheckUnavailable);
        }
        // Fund from the SET (R26): two smaller payments, or a top-up after a
        // fee rise, are exactly as spendable as one fat deposit.
        const selection = selectFundingUtxos(info.confirmedUtxos, info.estimatedCostSats);
        if (selection.selected.length === 0) {
          throw new DemoCopyError(
            depositShortfallMessage(selection.totalSats, selection.shortfallSats)
          );
        }
        const state = await engine.inscribe({
          funding: {
            fundingUtxos: selection.selected,
            changeAddress: bitcoin.fundingAddress,
            signingClient: bitcoin.signingClient,
          },
        });
        // The server distinguishes commit-only from a complete pair; the SDK
        // discards submitInscription's return, so read it off the provider.
        setSubmitOutcome({ kind: 'submitted', status: engine.lastSubmission?.broadcast ?? null });
        return state;
      }
      // testnet4: ask the server faucet to fund the user's address, then
      // inscribe with the user's Turnkey key. 507 surfaces a friendly message.
      const res = await fetch('/api/btc/funding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address: bitcoin.fundingAddress }),
      });
      if (res.status === 507) throw new DemoCopyError(demo.testnet4.faucetEmpty);
      if (!res.ok) throw new DemoCopyError(demo.testnet4.fundingFailed);
      const { fundingUtxo, changeAddress } = (await res.json()) as {
        fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey: string };
        changeAddress: string;
      };
      // The faucet funds exactly one output, so this stays a one-element set.
      return engine.inscribe({
        funding: { fundingUtxos: [fundingUtxo], changeAddress, signingClient: bitcoin.signingClient },
      });
    });

  const reset = () => {
    setPhase('idle');
    setAsset(null);
    setError(null);
    setTab('events');
    setCommitted(null);
    setUpdating(false);
    // The previous identity's money view is not the new one's.
    setDeposit(null);
    setDepositError(null);
    setDepositBadge(null);
    depositErrorRef.current = null;
    // Fresh artwork for the next run — and a fresh NAME with it, or the new
    // piece would inherit the last one's title. The source resets too: an
    // upload from the previous run is not part of a clean slate.
    const nextNonce = Math.floor(Math.random() * 1e9);
    setNonce(nextNonce);
    setSourceKind('generate');
    setUploaded(null);
    setWritten('');
    setSourceError(null);
    setTitle(generateName(style, nextNonce));
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

  // One decision, used by all three parts of the completion panel.
  const doneView = inscribeDoneView(submitOutcome);
  const step = phaseToStep[phase];
  const busy =
    phase === 'creating' || phase === 'publishing' || phase === 'inscribing' || updating;
  // Revisable while the asset is authorable for free — did:cel and did:webvh.
  // Not once inscribed: that append is paid on-chain (see DemoEngine.update).
  const canRevise = phase === 'created' || phase === 'published';
  // Compare the BYTES on screen against the bytes in the log. Retyping the
  // title back to its committed value therefore clears the pending state, and
  // a nonce bump that happened to reproduce the same art would too.
  const pendingRevision = canRevise && !!asset && !resourceMatchesSource(source, asset.resource);
  const discardRevision = () => {
    if (!committed) return;
    setTitle(committed.title);
    setStyle(committed.style);
    setNonce(committed.nonce);
    // The SOURCE is part of what was committed. Restoring only title/style/
    // nonce would leave an alternate source selected, so the revision stayed
    // pending and publishing stayed disabled with no way back but by hand.
    setSourceKind(committed.sourceKind);
    setUploaded(committed.uploaded);
    setWritten(committed.written);
    setSourceError(null);
  };
  // The form is the edit surface once an asset exists: typing a new title
  // regenerates the artwork, which IS the new version. Locked only while an
  // operation is in flight, or once inscribed (that append costs sats).
  const formLocked = busy || phase === 'inscribed';
  // Linked so a creator can watch the funding transaction confirm. Uses the
  // same explorer helper as the completed view, so a simulated run — where the
  // helper withholds the URL — offers no link to a transaction that isn't.
  const uncertainSubmission = submitOutcome.kind !== 'submitted' || !['commit_broadcast', 'reveal_broadcast'].includes(submitOutcome.status ?? '');
  const commitExplorerUrl = !uncertainSubmission && asset?.inscription?.commitTxId
    ? btcoExplorerUrl(asset.inscription.commitTxId)
    : undefined;

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
          <p>{demoSubhead(real, network)}</p>
          {network === 'regtest' && <p className="demo-inscribe-note">{demo.regtest.notice}</p>}
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
                    {sourceIsImage ? (
                      <img
                        src={
                          sourceKind === 'generate'
                            ? artwork.dataUri
                            : resourceDataUrl(source.content, source.contentType)
                        }
                        alt={`Artwork for “${title || demo.form.defaultTitle}”`}
                      />
                    ) : (
                      <pre className="demo-art-text">{contentText(source.content) || demo.form.writePlaceholder}</pre>
                    )}
                    {sourceKind === 'generate' && (phase === 'idle' || canRevise) && (
                      <button
                        type="button"
                        className="demo-art-refresh"
                        disabled={updating}
                        onClick={() => {
                          const next = nonce + 1;
                          renameWithArt(style, next);
                          setNonce(next);
                        }}
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
                    <div className="demo-field">
                      <span>{demo.form.sourceLabel}</span>
                      <div className="demo-source-tabs" role="tablist">
                        {([
                          ['generate', demo.form.sourceGenerate],
                          ['upload', demo.form.sourceUpload],
                          ['write', demo.form.sourceWrite]
                        ] as const).map(([kind, label]) => (
                          <button
                            key={kind}
                            type="button"
                            role="tab"
                            aria-selected={sourceKind === kind}
                            data-active={sourceKind === kind || undefined}
                            disabled={formLocked}
                            onClick={() => {
                              setSourceKind(kind);
                              setSourceError(null);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {sourceKind === 'generate' && (
                      <label className="demo-field">
                        <span>{demo.form.styleLabel}</span>
                        <select
                          value={style}
                          disabled={formLocked}
                          onChange={(e) => {
                            renameWithArt(e.target.value, nonce);
                            setStyle(e.target.value);
                          }}
                        >
                          {ART_STYLES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                    )}

                    {sourceKind === 'upload' && (
                      <label className="demo-field">
                        <span>{demo.form.uploadCta}</span>
                        <input
                          type="file"
                          accept=".png,image/png,.svg,image/svg+xml,.txt,.md,.json,.csv,text/plain"
                          disabled={formLocked}
                          onChange={(e) => void onPickFile(e.target.files?.[0])}
                        />
                      </label>
                    )}

                    {sourceKind === 'write' && (
                      <label className="demo-field">
                        <span>{demo.form.sourceWrite}</span>
                        <textarea
                          className="demo-source-text"
                          value={written}
                          rows={5}
                          placeholder={demo.form.writePlaceholder}
                          disabled={formLocked}
                          onChange={(e) => setWritten(e.target.value)}
                        />
                      </label>
                    )}

                    {sourceKind === 'write' && written.length > 0 && (
                      <p className="demo-source-count" data-over={sourceTooBig || undefined}>
                        {sourceBytes.toLocaleString()} / {MAX_SOURCE_BYTES.toLocaleString()} bytes
                      </p>
                    )}
                    {(sourceError ?? (sourceTooBig ? demo.form.uploadTooBig : null)) && (
                      <p className="demo-source-error">
                        {sourceError ?? demo.form.uploadTooBig}
                      </p>
                    )}
                    <p className="demo-art-hint">
                      {sourceKind === 'generate'
                        ? demo.form.artHint
                        : sourceKind === 'upload'
                          ? demo.form.uploadHint
                          : demo.form.writeHint}
                    </p>
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
                                Account required
                              </span>
                            )}
                          </div>
                          <p>{i === 2 ? inscribeView.description : s.description}</p>
                          {/* R7: an anonymous publish is temporary and shares a
                              demo path. Said HERE — in the publish step, from
                              first paint — because after the log exists is too
                              late to decide to sign in first. */}
                          {i === 1 && durabilityNote && (
                            <p className="demo-step-note">{durabilityNote}</p>
                          )}
                          {state !== 'done' && (
                            // Step 3 in the simulated tier runs the SDK's mock
                            // provider for real — completable, not disabled —
                            // so its "this is not Bitcoin" signal is the
                            // treatment and the label, never a dead button.
                            <button
                              type="button"
                              className={i === 2 ? inscribeView.buttonClass : 'btn btn-primary demo-step-btn'}
                              disabled={(i === 2 && !real) || stepButtonDisabled({
                                index: i,
                                state,
                                titleEmpty: title.trim().length === 0,
                                pendingRevision,
                                updating,
                                anyRunning: busy,
                              })}
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
                          {/* The one price a signed-out visitor ever sees, and
                              it belongs in this step — beside the thing that
                              would spend it, not in a table further down the
                              page. BELOW the button, though: above it, this
                              sat directly on top of "Run the simulation" and
                              read as that button's price. */}
                          {i === 2 && costNote && (
                            <p className="demo-step-note demo-cost-note">{costNote}</p>
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

                {phase === 'published' && real && network === 'testnet4' && (
                  <p className="demo-inscribe-note">
                    {gate === 'ok'
                      ? demo.testnet4.yourKeyNote
                      : signingGateMessage(gate, network, signing)}
                  </p>
                )}

                {phase === 'published' && real && networkMismatch && (
                  <p className="demo-error" role="alert">{demo.deposit.networkMismatch}</p>
                )}

                {phase === 'published' && (network === 'mainnet' || network === 'regtest') && !networkMismatch && (
                  gate === 'ok' && bitcoin ? (
                    <div className="demo-deposit">
                      <div className="demo-deposit-head">
                        <strong>{demo.deposit.heading}</strong>
                        <span
                          className="demo-resolved-badge"
                          data-ok={readiness === 'ready' || undefined}
                        >
                          {depositError
                            ? depositBadge ?? demo.deposit.unknownBadge
                            : depositBadgeLabel(readiness, demo.deposit)}
                        </span>
                      </div>
                      {/* R27 still renders in full and in every state — it
                          moved INTO DepositPanel, below the address rather
                          than between the amount and it. depositDisclosure()
                          remains the contract for what must be present. */}
                      {deposit ? (
                        <>
                          <DepositPanel
                            address={bitcoin.fundingAddress}
                            sats={deposit.estimatedCostSats}
                            balanceSats={deposit.confirmedSats ?? 0}
                            funded={readiness === 'ready'}
                            pendingSats={deposit.unconfirmedSats}
                            shortfall={
                              readiness === 'short'
                                ? {
                                    heldSats: deposit.confirmedUtxos.reduce((n, u) => n + u.value, 0),
                                    shortfallSats:
                                      deposit.estimatedCostSats -
                                      deposit.confirmedUtxos.reduce((n, u) => n + u.value, 0),
                                  }
                                : null
                            }
                            pendingHref={
                              deposit.pendingDeposit
                                ? explorerTxUrl(network, deposit.pendingDeposit.txid)
                                : null
                            }
                          />
                          {deposit.pendingDeposit && (
                            <DepositFeeNotice pending={deposit.pendingDeposit} />
                          )}
                          <p className="demo-inscribe-note deposit-topup">
                            {demo.deposit.topUpNote}
                          </p>
                        </>
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
                      {deposit?.ordinalCheck === 'unavailable' && (
                        <p className="demo-error" role="alert">{demo.deposit.ordinalCheckUnavailable}</p>
                      )}
                      {deposit?.ordinalCheck === 'partial' && (
                        <p className="demo-inscribe-note">
                          {demo.deposit.ordinalCheckPartial(deposit.uncheckedOutputs ?? 0)}
                        </p>
                      )}
                    </div>
                  ) : gate === 'unavailable' ? (
                    // No re-auth CTA here on purpose: signing in is what
                    // failed, so offering it again is a loop, not a remedy.
                    <div className="demo-deposit">
                      <div className="demo-deposit-head">
                        <strong>{demo.session.unavailableHeading}</strong>
                      </div>
                      {/* A refusal made on the user's behalf (#494) says so; anything else is on us. */}
                      <p className="demo-error" role="alert">{signingNotice ?? signingGateMessage(gate, network, signing)}</p>
                      <p className="demo-inscribe-note">{demo.session.preserved}</p>
                    </div>
                  ) : gate === 'reauth' ? (
                    <div className="demo-deposit">
                      <div className="demo-deposit-head">
                        <strong>{demo.session.expiredHeading}</strong>
                      </div>
                      <p className="demo-error" role="alert">{signingNotice ?? signingGateMessage(gate, network, signing)}</p>
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
                    <p className="demo-inscribe-note">{signingNotice ?? signingGateMessage(gate, network, signing)}</p>
                  )
                )}

                {(phase === 'published' || phase === 'inscribing' || phase === 'inscribed') &&
                  asset?.webvhLogUrl && (
                    <div className="demo-resolved">
                      <div className="demo-resolved-head">
                        {/* An anonymous log is served from the shared in-memory
                            host store, so the heading stops short of calling it
                            a permanent home. The caveat itself is up in the
                            publish step, where it can still change a mind. */}
                        <span>{resolved.heading}</span>
                        <span
                          className="demo-resolved-badge"
                          data-ok={asset.webvhResolved || undefined}
                        >
                          {asset.webvhResolved
                            ? resolved.resolvedBadge
                            : resolved.pendingBadge}
                        </span>
                      </div>
                      <a
                        className="demo-resolved-link"
                        href={asset.webvhLogUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {resolved.linkLabel}
                        <code>{asset.webvhLogUrl}</code>
                      </a>
                      <p className="demo-resolved-note">{resolved.note}</p>
                    </div>
                  )}

                {phase === 'inscribed' && asset && (
                  <div className="demo-done" data-sim={inscribeView.simulated ? '' : undefined}>
                    {/* Commit-only is not "inscribed": the reveal carries
                        the inscription, and until it propagates there is
                        nothing on chain to point at. */}
                    {!doneView.claimComplete && (
                      <div className="deposit-funded" role="status">
                        <strong className="deposit-funded-heading">{uncertainSubmission ? 'Submission status is uncertain' : demo.deposit.commitOnlyHeading}</strong>
                        <p className="deposit-funded-body">{uncertainSubmission ? 'This browser retained the signed publication. Open Your Originals to retry the same transactions without rebuilding or signing again.' : demo.deposit.commitOnlyBody}</p>
                      </div>
                    )}
                    {/* Both the completion sentence and the explorer link are
                        withheld while only the commit has landed. Rendering
                        them under the pending notice is what let the page go
                        on claiming completion — and link to a reveal txid that
                        404s — while saying above that it had not finished. */}
                    {!doneView.claimComplete ? (
                      <>
                        <p className="demo-inscribe-note">
                          {demo.deposit.commitOnlySatPrefix}{' '}
                          <code>{asset.inscription?.satoshi}</code>.
                        </p>
                        {/* The funding txid, linked. Without it this step says
                            "wait" and gives no way to watch — which reads as
                            nothing having happened, at the exact moment real
                            money just moved. */}
                        {commitExplorerUrl && (
                          <p className="demo-inscribe-note">
                            {demo.deposit.commitOnlyTxLabel}{' '}
                            <a
                              className="demo-explorer-link"
                              href={commitExplorerUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <code>{asset.inscription?.commitTxId}</code>
                            </a>
                            {asset.inscription?.feeRate
                              ? ` — ${demo.deposit.commitOnlyFeeLabel} ${asset.inscription.feeRate} sat/vB`
                              : ''}
                          </p>
                        )}
                        <p className="demo-inscribe-note">
                          {demo.deposit.commitOnlyRevealPending}
                        </p>
                        <a className="demo-explorer-link" href="/me">
                          {demo.deposit.commitOnlyTrackLink}
                        </a>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>{done.lead}</strong> {done.beforeSatoshi}{' '}
                          <code>{asset.inscription?.satoshi}</code> {done.beforeTx}{' '}
                          <code>{asset.inscription?.txid}</code>. {done.after}
                        </p>
                        {/* The engine withholds the explorer URL in the simulated
                            tier (U2); the label goes with it, so no completion
                            screen can offer a link to a transaction that isn't. */}
                        {doneView.showExplorerLink && asset.inscription?.explorerUrl && done.explorerLabel && (
                          <a
                            className="demo-explorer-link"
                            href={asset.inscription.explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {done.explorerLabel}
                          </a>
                        )}
                      </>
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
                            src={resourceDataUrl(asset.resource.content, asset.resource.contentType)}
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
{'\n'}{asset.resource.content instanceof Uint8Array ? `${asset.resource.content.byteLength} binary bytes · ${asset.resource.contentType}` : asset.resource.content}</code>
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
  const entries: Array<[string, string]> = [['Asset ID', asset.did]];
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
