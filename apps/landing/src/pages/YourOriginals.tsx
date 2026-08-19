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
  /** Present once the Original migrated to did:btco (real inscription). */
  btcoDid?: string;
  inscriptionId?: string;
  commitTxId?: string;
  revealTxId?: string;
  satoshi?: string;
  inscriptionStatus?: 'pending' | 'confirmed';
}

/** One in-flight inscription record from GET /api/btc/inscribe. */
export interface PendingInscription {
  commitTxId: string;
  revealTxId: string;
  inscriptionId: string;
  fundingOutpoint: string;
  status: 'signed' | 'commit_broadcast' | 'reveal_broadcast' | 'confirmed';
  /** A rebuilt pair took over this record's funding outpoint (kept for recovery, not actionable here). */
  superseded?: boolean;
  createdAt: string;
}

/**
 * Records whose reveal is NOT yet broadcast — the "finish inscription" set.
 * Superseded records are excluded: a live rebuilt pair owns their outpoint,
 * so offering "finish" on them would race it (the server keeps them purely
 * as recovery artifacts in case their commit landed despite the failure).
 */
export function unfinishedInscriptions(records: PendingInscription[]): PendingInscription[] {
  return records.filter(
    (r) => !r.superseded && (r.status === 'signed' || r.status === 'commit_broadcast')
  );
}

/**
 * Overlay live confirmation onto stored rows: the durable Original record is
 * written once as 'pending' at inscribe time, while the inscriptions store
 * tracks confirmation sticky — join them by commitTxId so /me and the proof
 * page show 'confirmed' without any re-posting.
 */
export function withLiveInscriptionStatus(
  rows: OriginalRow[],
  records: PendingInscription[]
): OriginalRow[] {
  return rows.map((r) => {
    if (!r.commitTxId || r.inscriptionStatus === 'confirmed') return r;
    const rec = records.find((x) => x.commitTxId === r.commitTxId);
    return rec?.status === 'confirmed' ? { ...r, inscriptionStatus: 'confirmed' as const } : r;
  });
}

/** The user's inscription records ([] when signed out / unavailable). */
export async function fetchInscriptions(): Promise<PendingInscription[]> {
  try {
    const res = await fetch('/api/btc/inscribe', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = (await res.json()) as { inscriptions?: PendingInscription[] };
    return body.inscriptions ?? [];
  } catch {
    return [];
  }
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
    const { OriginalsSDK } = await import('@originals/sdk');
    const { OrdMockProvider } = await import('@originals/sdk/testing');
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
  const [unfinished, setUnfinished] = useState<PendingInscription[]>([]);
  const [finishing, setFinishing] = useState<string | null>(null);
  const [finishNote, setFinishNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let live = true;
    // Fetch rows + inscription records together: the records carry the live
    // (sticky) confirmation state that the durable rows only hold as
    // 'pending', and any record whose reveal never broadcast gets a
    // "finish inscription" offer — the signed txs are on the server, nothing
    // needs re-signing (step-1 recovery surface).
    Promise.all([fetchOriginals(), fetchInscriptions()]).then(([rows, recs]) => {
      if (!live) return;
      const merged = withLiveInscriptionStatus(rows, recs);
      setOriginals(merged);
      setUnfinished(unfinishedInscriptions(recs));
      merged.forEach((r) => resolveLive(r.did).then((ok) => live && setResolved((m) => ({ ...m, [r.did]: ok }))));
    });
    return () => { live = false; };
  }, [isAuthenticated]);

  const finishInscription = async (commitTxId: string) => {
    setFinishing(commitTxId);
    setFinishNote(null);
    try {
      const res = await fetch('/api/btc/inscribe/rebroadcast', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commitTxId }),
      });
      const ok = res.ok && ['reveal_broadcast', 'confirmed'].includes(
        ((await res.json().catch(() => ({}))) as { status?: string }).status ?? ''
      );
      setFinishNote(ok ? yourOriginals.finish.done : yourOriginals.finish.failed);
      if (ok) setUnfinished((u) => u.filter((r) => r.commitTxId !== commitTxId));
    } catch {
      setFinishNote(yourOriginals.finish.failed);
    } finally {
      setFinishing(null);
    }
  };

  const view = originalsView({ authenticated: isAuthenticated, originals });

  return (
    <main className="section your-originals">
      <div className="container">
        <p className="eyebrow">{yourOriginals.navLabel}</p>
        <h1>{yourOriginals.heading}</h1>
        <p className="your-originals-sub">{yourOriginals.subhead}</p>

        {view.mode === 'signed-out' && <p className="your-originals-note">{yourOriginals.signedOut}</p>}

        {isAuthenticated && unfinished.length > 0 && (
          <div className="card your-originals-finish" role="alert">
            <p className="your-originals-finish-title">{yourOriginals.finish.heading}</p>
            <p>{yourOriginals.finish.body}</p>
            <ul>
              {unfinished.map((rec) => (
                <li key={rec.commitTxId}>
                  <code title={rec.inscriptionId}>{rec.inscriptionId.slice(0, 16)}…</code>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={finishing === rec.commitTxId}
                    onClick={() => void finishInscription(rec.commitTxId)}
                  >
                    {finishing === rec.commitTxId ? yourOriginals.finish.busy : yourOriginals.finish.cta}
                  </button>
                </li>
              ))}
            </ul>
            {finishNote && <p className="your-originals-note">{finishNote}</p>}
          </div>
        )}

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
                      <span className="layer-pill" data-layer={row.btcoDid ? 'did:btco' : 'did:webvh'}>
                        <span className="dot" />
                        {row.btcoDid ? 'did:btco' : 'did:webvh'}
                      </span>
                      {row.btcoDid && (
                        <span
                          className="your-original-badge your-original-inscription"
                          data-ok={row.inscriptionStatus === 'confirmed' || undefined}
                        >
                          {row.inscriptionStatus === 'confirmed'
                            ? yourOriginals.inscribedBadge
                            : yourOriginals.inscriptionPendingBadge}
                        </span>
                      )}
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
