import { useEffect, useRef, useState } from 'react';
import { realExample, mainnetExample } from '../content';
import type { VerifiedExample } from '../sdk/verify-example';
import type { MainnetExampleResult } from '../sdk/verify-mainnet-example';
import { Reveal } from './Reveal';
import { short } from '../sdk/format';
import { explorerTxUrl } from '../sdk/explorer';
import './real-example.css';

type State =
  | { status: 'pending' }
  | { status: 'done'; result: VerifiedExample }
  | { status: 'failed' };

type MainnetState =
  | { status: 'pending' }
  | { status: 'done'; result: MainnetExampleResult }
  | { status: 'failed' };

export function RealExample() {
  const [state, setState] = useState<State>({ status: 'pending' });
  const [mainnetState, setMainnetState] = useState<MainnetState>({ status: 'pending' });
  const rootRef = useRef<HTMLElement>(null);
  const started = useRef(false);

  // Verify lazily, when the section approaches the viewport — the checks are
  // real cryptography and ride in the same lazy chunk as the demo SDK.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || started.current) return;
        started.current = true;
        io.disconnect();
        import('../sdk/verify-example')
          .then(({ verifyExample }) => verifyExample())
          .then((result) => setState({ status: 'done', result }))
          .catch((err) => {
            console.error('[originals-demo] example verification failed', err);
            setState({ status: 'failed' });
          });
        // verifyMainnetExample() never rejects (it falls back to the retained
        // receipt internally) — this catch only guards an unexpected import failure.
        import('../sdk/verify-mainnet-example')
          .then(({ verifyMainnetExample }) => verifyMainnetExample())
          .then((result) => setMainnetState({ status: 'done', result }))
          .catch((err) => {
            console.error('[originals-demo] mainnet example check failed', err);
            setMainnetState({ status: 'failed' });
          });
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const result = state.status === 'done' ? state.result : null;
  const mainnetResult = mainnetState.status === 'done' ? mainnetState.result : null;

  return (
    <section className="section example" id={realExample.id} ref={rootRef}>
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{realExample.eyebrow}</p>
          <h2>{realExample.headline}</h2>
          <p>{realExample.subhead}</p>
        </Reveal>

        <Reveal>
          <div className="card example-shell">
            <div className="example-art">
              {result ? (
                <img src={result.artworkDataUri} alt={`“${result.title}” — the example Original's artwork`} />
              ) : (
                <div className="example-art-placeholder" aria-hidden="true" />
              )}
            </div>
            <div className="example-body">
              <header className="example-head">
                <div>
                  <h3>{result ? `“${result.title}”` : '…'}</h3>
                  {result && (
                    <p className="example-medium">{result.medium}</p>
                  )}
                </div>
                {state.status === 'pending' && (
                  <span className="example-badge" data-state="pending">
                    <span className="demo-spinner example-spinner" aria-hidden="true" />
                    {realExample.pendingLabel}
                  </span>
                )}
                {state.status === 'done' && (
                  <span className="example-badge" data-state={result?.allOk ? 'ok' : 'warn'}>
                    {result?.allOk ? realExample.verifiedBadge : realExample.failedBadge}
                  </span>
                )}
                {state.status === 'failed' && (
                  <span className="example-badge" data-state="warn">
                    {realExample.failedBadge}
                  </span>
                )}
              </header>

              {state.status === 'failed' ? (
                <p className="example-fail">{realExample.failNote}</p>
              ) : (
                <>
                  <ul className="example-checks">
                    {(['hash', 'log', 'cel'] as const).map((id) => {
                      const check = result?.checks.find((c) => c.id === id);
                      const status = !check ? 'pending' : check.ok ? 'ok' : 'fail';
                      return (
                        <li key={id} data-state={status}>
                          <span className="example-check-mark" aria-hidden="true">
                            {status === 'ok' ? (
                              <svg viewBox="0 0 16 16">
                                <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : status === 'fail' ? (
                              <svg viewBox="0 0 16 16">
                                <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <span className="example-check-dot" />
                            )}
                          </span>
                          <div>
                            <p className="example-check-label">{realExample.checkLabels[id]}</p>
                            {check && <p className="example-check-detail">{check.detail}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {result && (
                    <dl className="demo-kv example-kv">
                      <div>
                        <dt>{realExample.fields.identity}</dt>
                        <dd>
                          <code title={result.dids.cel}>{short(result.dids.cel, 34, 8)}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{realExample.fields.published}</dt>
                        <dd>
                          <code title={result.dids.webvh}>{result.dids.webvh}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{realExample.fields.profile}</dt>
                        <dd>
                          <code>{result.profile}</code>
                        </dd>
                      </div>
                      {result.issuedAt && (
                        <div>
                          <dt>{realExample.fields.issued}</dt>
                          <dd>
                            <code>{result.issuedAt}</code>
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                </>
              )}

              <a
                className="example-artifacts"
                href={realExample.artifactsHref}
                target="_blank"
                rel="noreferrer"
              >
                {realExample.artifactsLabel}
                <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
                  <path d="M6 3h7v7M13 3 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          </div>
        </Reveal>

        <Reveal>
          <div className="card example-shell mainnet-shell">
            <div className="example-body">
              <header className="example-head">
                <div>
                  <p className="eyebrow">{mainnetExample.eyebrow}</p>
                  <h3>{mainnetExample.headline}</h3>
                </div>
                {mainnetState.status === 'pending' && (
                  <span className="example-badge" data-state="pending">
                    <span className="demo-spinner example-spinner" aria-hidden="true" />
                    {mainnetExample.pendingLabel}
                  </span>
                )}
                {mainnetResult && (
                  <span className="example-badge" data-state={mainnetResult.live ? 'ok' : 'warn'}>
                    {mainnetResult.live ? mainnetExample.liveBadge : mainnetExample.retainedBadge}
                  </span>
                )}
                {mainnetState.status === 'failed' && (
                  <span className="example-badge" data-state="warn">
                    {mainnetExample.retainedBadge}
                  </span>
                )}
              </header>

              <p className="example-medium">{mainnetExample.subhead}</p>

              {mainnetResult && (
                <>
                  <dl className="demo-kv example-kv">
                    <div>
                      <dt>{mainnetExample.fields.identity}</dt>
                      <dd>
                        <code title={mainnetResult.didBtco}>{mainnetResult.didBtco}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{mainnetExample.fields.inscription}</dt>
                      <dd>
                        <code title={mainnetResult.inscriptionId}>
                          {short(mainnetResult.inscriptionId, 20, 10)}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>{mainnetExample.fields.sat}</dt>
                      <dd>
                        <code>{mainnetResult.sat}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{mainnetExample.fields.resource}</dt>
                      <dd>
                        <code>{mainnetResult.resource.id}</code> —{' '}
                        {mainnetResult.resourceOnChain
                          ? mainnetExample.resourceOnChainNote
                          : mainnetExample.resourceOffChainNote}
                      </dd>
                    </div>
                  </dl>

                  <p className="example-medium mainnet-trust-note">{mainnetExample.trustNote}</p>

                  <div className="mainnet-links">
                    {explorerTxUrl('mainnet', mainnetResult.revealTxId) && (
                      <a
                        className="example-artifacts"
                        href={explorerTxUrl('mainnet', mainnetResult.revealTxId)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {mainnetExample.explorerLabel}
                        <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
                          <path d="M6 3h7v7M13 3 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </a>
                    )}
                    <a
                      className="example-artifacts"
                      href={mainnetResult.sourceHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {mainnetExample.receiptLabel}
                      <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
                        <path d="M6 3h7v7M13 3 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
