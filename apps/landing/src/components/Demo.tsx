import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { demo } from '../content';
import type { DemoAssetState, DemoEngine, DemoEvent } from '../sdk/engine';
import { generateArtwork } from '../sdk/artwork';
import { getArtSeed, setArtSeed } from '../sdk/artwork-sync';
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

const phaseToStep: Record<Phase, number> = {
  idle: 0,
  creating: 0,
  created: 1,
  publishing: 1,
  published: 2,
  inscribing: 2,
  inscribed: 3
};

const eventColors: Record<string, string> = {
  'asset:created': 'var(--peer)',
  'did:webvh:created': 'var(--webvh)',
  'resource:published': 'var(--webvh)',
  'did:webvh:resolved': 'var(--webvh)',
  'asset:migrated': 'var(--webvh)',
  'credential:issued': 'var(--ok)',
  'asset:inscribed': 'var(--btco)'
};

function useEngine() {
  const engineRef = useRef<DemoEngine | null>(null);
  const loading = useRef<Promise<DemoEngine> | null>(null);

  const getEngine = useCallback(async (): Promise<DemoEngine> => {
    if (engineRef.current) return engineRef.current;
    loading.current ??= import('../sdk/engine').then(({ DemoEngine }) => {
      // The engine registers itself as window.__originalsDemo so skeptics can
      // inspect it from the devtools console.
      const engine = new DemoEngine();
      engineRef.current = engine;
      return engine;
    });
    return loading.current;
  }, []);

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
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [asset, setAsset] = useState<DemoAssetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'events' | 'provenance' | 'resource'>('events');
  const { getEngine, discardEngine } = useEngine();
  const logRef = useRef<HTMLOListElement>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

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

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  // Detach the engine listener if the component ever unmounts (e.g. under
  // client-side routing), so no state updates target an unmounted tree.
  useEffect(() => () => unsubscribe.current?.(), []);

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
      if (from === 'idle') {
        unsubscribe.current?.();
        unsubscribe.current = engine.on((event) =>
          setEvents((prev) => [...prev, event])
        );
      }
      const state = await action(engine);
      setAsset(state);
      setPhase(done);
    } catch (err) {
      console.error('[originals-demo]', err);
      setError((err as Error).message);
      setPhase(from);
    }
  };

  const create = () =>
    run('idle', 'creating', 'created', (engine) =>
      engine.create(title.trim() || demo.form.defaultTitle, medium, artwork.svg)
    );
  const publish = () =>
    run('created', 'publishing', 'published', (engine) => engine.publish());
  const inscribe = () =>
    run('published', 'inscribing', 'inscribed', (engine) => engine.inscribe(7));

  const reset = () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    setPhase('idle');
    setEvents([]);
    setAsset(null);
    setError(null);
    setTab('events');
    setNonce(Math.floor(Math.random() * 1e9)); // fresh artwork for the next run
    // Next run gets a fresh engine — fresh keys, fresh DIDs, fresh publisher.
    // window.__originalsDemo keeps pointing at the old engine until the new
    // one constructs and re-registers itself, so the hook is never dangling.
    discardEngine();
    void getEngine();
  };

  const step = phaseToStep[phase];
  const busy = phase === 'creating' || phase === 'publishing' || phase === 'inscribing';
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
              <Pipeline active={busy ? step : step > 2 ? 2 : step} busy={busy} />
            </div>

            <div className="demo-body">
              <div className="demo-controls">
                <div className="demo-asset" data-layer={asset?.layer ?? 'draft'}>
                  <div className="demo-art">
                    <img src={artwork.dataUri} alt={`Generated artwork for “${title || demo.form.defaultTitle}”`} />
                    {phase === 'idle' && (
                      <button
                        type="button"
                        className="demo-art-refresh"
                        onClick={() => setNonce((n) => n + 1)}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M13.3 6.6A5.6 5.6 0 0 0 3.1 5.2M2.7 9.4a5.6 5.6 0 0 0 10.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <path d="M3 2.4v2.9h2.9M13 13.6v-2.9h-2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {demo.form.regenerate}
                      </button>
                    )}
                    <span className="demo-art-badge layer-pill" data-layer={asset?.layer ?? undefined}>
                      <span className="dot" />
                      {asset?.layer ?? 'draft'}
                    </span>
                  </div>
                  <div className="demo-form" data-disabled={phase !== 'idle' || undefined}>
                    <label className="demo-field">
                      <span>{demo.form.titleLabel}</span>
                      <input
                        type="text"
                        value={title}
                        maxLength={80}
                        placeholder={demo.form.titlePlaceholder}
                        disabled={phase !== 'idle'}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </label>
                    <label className="demo-field">
                      <span>{demo.form.mediumLabel}</span>
                      <select
                        value={medium}
                        disabled={phase !== 'idle'}
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
                      <li key={s.id} className="demo-step" data-state={state}>
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
                          </div>
                          <p>{s.description}</p>
                          {state !== 'done' && (
                            <button
                              type="button"
                              className="btn btn-primary demo-step-btn"
                              disabled={
                                (state !== 'ready' && state !== 'busy') ||
                                (i === 0 && title.trim().length === 0)
                              }
                              data-busy={state === 'busy' || undefined}
                              onClick={stepActions[i]}
                            >
                              {state === 'busy' ? (
                                <>
                                  <span className="demo-spinner" aria-hidden="true" />
                                  {s.pending}
                                </>
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

                {error && <p className="demo-error" role="alert">{error}</p>}

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
                    </div>
                  )}

                {phase === 'inscribed' && asset && (
                  <div className="demo-done">
                    <p>
                      <strong>{demo.done.lead}</strong> {demo.done.beforeSatoshi}{' '}
                      <code>{asset.inscription?.satoshi}</code> {demo.done.beforeTx}{' '}
                      <code>{asset.inscription?.txid}</code>. {demo.done.after}
                    </p>
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
                    {events.length > 0 && <span className="demo-tab-count">{events.length}</span>}
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
                    {events.length === 0 ? (
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
                      <>
                        <ol className="demo-log" ref={logRef} aria-live="polite">
                          {events.map((event, i) => (
                            <li key={i} className="demo-log-row">
                              <span
                                className="demo-log-dot"
                                style={{ background: eventColors[event.type] ?? 'var(--text-tertiary)' }}
                              />
                              <div>
                                <div className="demo-log-meta">
                                  <code>{event.type}</code>
                                  <time>{event.at.slice(11, 23)}</time>
                                </div>
                                <p>{event.summary}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                        <p className="demo-log-source">{demo.eventLog.sourceNote}</p>
                      </>
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
  const entries: Array<[string, string]> = [['did:peer', asset.did]];
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
