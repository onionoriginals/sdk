/**
 * The /me "Your Originals" page. Auth-gated: signed-out users get a prompt;
 * signed-in users see their durable did:webvh Originals (artwork thumbnail,
 * title, did with a live "resolved ✓", open-log link, created date). Empty
 * state links back to the demo.
 */
import { useEffect, useState } from 'react';
import { yourOriginals } from '../content';
import { useAuth } from '../auth/useAuth';
import { navigate } from '../router';
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

async function fetchOriginals(): Promise<OriginalRow[]> {
  const res = await fetch('/api/originals', { credentials: 'same-origin' });
  if (!res.ok) return [];
  const body = (await res.json()) as { originals?: OriginalRow[] };
  return body.originals ?? [];
}

// Best-effort live resolution proof (production only — the resolver forces
// https, so a dev http origin returns false; the row still renders).
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

function didLogUrl(did: string): string {
  const parts = did.split(':'); // did:webvh:<SCID>:<host>[:<seg>…]
  const host = decodeURIComponent(parts[3] ?? '');
  const segs = parts.slice(4).map((s) => decodeURIComponent(s));
  return segs.length ? `https://${host}/${segs.join('/')}/did.jsonl` : `https://${host}/.well-known/did.jsonl`;
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
          <ul className="your-originals-list">
            {view.rows.map((row) => {
              const logUrl = didLogUrl(row.did);
              const ok = resolved[row.did];
              return (
                <li key={row.did} className="your-original">
                  {row.resourceUrl ? (
                    <img className="your-original-thumb" src={row.resourceUrl} alt={`Artwork for “${row.title}”`} />
                  ) : (
                    <span className="your-original-thumb your-original-thumb-empty" aria-hidden="true" />
                  )}
                  <div className="your-original-body">
                    <h2>{row.title}</h2>
                    <div className="your-original-did">
                      <code title={row.did}>{row.did}</code>
                      <span className="your-original-badge" data-ok={ok || undefined}>
                        {ok ? yourOriginals.resolvedBadge : yourOriginals.pendingBadge}
                      </span>
                    </div>
                    <a href={logUrl} target="_blank" rel="noreferrer" className="your-original-log">
                      {yourOriginals.openLog}
                    </a>
                    <p className="your-original-created">
                      {yourOriginals.createdLabel} {row.createdAt.slice(0, 10)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
