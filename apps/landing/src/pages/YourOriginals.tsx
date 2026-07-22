/**
 * The /me "Your Originals" page. Auth-gated: signed-out users get a prompt;
 * signed-in users see their durable did:webvh Originals as a gallery of cards
 * (artwork cover, title, did with a live "resolved ✓", created date). Each
 * card opens the Original's own detail page ('/me/<did>') where the full
 * provenance — CEL timeline, signed DID log, sealed resources — is laid out
 * and re-verified in the browser. Empty state links back to the demo.
 */
import { useEffect, useState } from 'react';
import { yourOriginals } from '../content';
import { useAuth } from '../auth/useAuth';
import { navigate, originalPath } from '../router';
import { sameOriginUrl } from './original-detail-data';
import './your-originals.css';

export interface OriginalRow {
  did: string;
  title: string;
  resourceHash: string;
  createdAt: string;
  resourceUrl?: string;
}

// Pure view selector — testable without a DOM.
export function originalsView(input: { authenticated: boolean; originals: OriginalRow[] }): {
  mode: 'signed-out' | 'empty' | 'list';
  rows: OriginalRow[];
} {
  if (!input.authenticated) return { mode: 'signed-out', rows: [] };
  if (input.originals.length === 0) return { mode: 'empty', rows: [] };
  return { mode: 'list', rows: input.originals };
}

/** The signed-in user's Originals, newest first ([] when signed out / on error). */
export async function fetchOriginals(): Promise<OriginalRow[]> {
  try {
    const res = await fetch('/api/originals', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = (await res.json()) as { originals?: OriginalRow[] };
    return body.originals ?? [];
  } catch {
    return [];
  }
}

// Best-effort live resolution proof (production only — the resolver forces
// https, so a dev http origin returns false; the card still renders).
async function resolveLive(did: string): Promise<boolean> {
  try {
    const { OriginalsSDK, OrdMockProvider } = await import('@originals/sdk');
    const { HttpHostingStorageAdapter } = await import('../sdk/http-hosting-adapter');
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      storageAdapter: new HttpHostingStorageAdapter(),
      enableLogging: false,
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
    return !!(await sdk.did.resolveDID(did, { skipCache: true } as never));
  } catch {
    return false;
  }
}

export function YourOriginals() {
  const { isAuthenticated } = useAuth();
  const [originals, setOriginals] = useState<OriginalRow[]>([]);
  const [resolved, setResolved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isAuthenticated) return;
    let live = true;
    fetchOriginals().then((rows) => {
      if (!live) return;
      setOriginals(rows);
      rows.forEach((r) => resolveLive(r.did).then((ok) => live && setResolved((m) => ({ ...m, [r.did]: ok }))));
    });
    return () => { live = false; };
  }, [isAuthenticated]);

  const view = originalsView({ authenticated: isAuthenticated, originals });

  return (
    <main className="section your-originals">
      <div className="container">
        <p className="eyebrow">{yourOriginals.navLabel}</p>
        <h1>{yourOriginals.heading}</h1>
        <p className="your-originals-sub">{yourOriginals.subhead}</p>

        {view.mode === 'signed-out' && <p className="your-originals-note">{yourOriginals.signedOut}</p>}

        {view.mode === 'empty' && (
          <div className="your-originals-empty">
            <p className="your-originals-empty-title">{yourOriginals.emptyTitle}</p>
            <p>{yourOriginals.emptyBody}</p>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
              {yourOriginals.emptyCta}
            </button>
          </div>
        )}

        {view.mode === 'list' && (
          <ul className="your-originals-grid">
            {view.rows.map((row) => {
              const href = originalPath(row.did);
              const ok = resolved[row.did];
              return (
                <li key={row.did}>
                  <a
                    className="card your-original-card"
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(href);
                    }}
                    aria-label={`“${row.title}” — ${yourOriginals.viewLabel}`}
                  >
                    <span className="your-original-cover">
                      {row.resourceUrl ? (
                        <img src={sameOriginUrl(row.resourceUrl, window.location.host)} alt="" />
                      ) : (
                        <span className="your-original-cover-empty" aria-hidden="true" />
                      )}
                      <span className="your-original-badge" data-ok={ok || undefined}>
                        {ok ? yourOriginals.resolvedBadge : yourOriginals.pendingBadge}
                      </span>
                    </span>
                    <span className="your-original-card-body">
                      <span className="layer-pill" data-layer="did:webvh">
                        <span className="dot" />
                        did:webvh
                      </span>
                      <h2>{row.title}</h2>
                      <code className="your-original-did" title={row.did}>{row.did}</code>
                      <span className="your-original-foot">
                        <span className="your-original-created">
                          {yourOriginals.createdLabel} {row.createdAt.slice(0, 10)}
                        </span>
                        <span className="your-original-view">
                          {yourOriginals.viewLabel}
                          <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
                            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
