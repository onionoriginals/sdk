/**
 * The '/me/<did>' page — one Original, fully expanded. Auth-gated like /me.
 *
 * Everything shown is pulled from the Original's real artifacts hosted at this
 * origin: the CEL event log (cel.json) drives the provenance timeline, the
 * signed did:webvh log (did.jsonl) drives the identity section, and the sealed
 * resources render from their hosted bytes. A lazy verification pass re-checks
 * hashes and both proof chains in the visitor's browser (verify-original.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { originalDetail } from '../content';
import { useAuth } from '../auth/useAuth';
import { navigate } from '../router';
import { short } from '../sdk/format';
import type { OriginalCheck } from '../sdk/verify-original';
import { fetchOriginals, type OriginalRow } from './YourOriginals';
import {
  webvhArtifacts,
  celTimeline,
  celResources,
  parseDidLog,
  didLogSummary,
  digestMultibaseSha256Hex,
  sha256HexToResourceMultibase,
  sameOriginUrl,
  detailMode,
  type CelLog,
  type CelResourceRef,
  type DidLogSummary,
  type TimelineStep
} from './original-detail-data';
import './original-detail.css';

interface DetailData {
  row: OriginalRow | null;
  cel: CelLog | null;
  logEntries: ReturnType<typeof parseDidLog> | null;
  logSummary: DidLogSummary | null;
  resources: CelResourceRef[];
  /** Hosted URL + fetched text per resource id (text only for JSON/text types). */
  resourceUrls: Record<string, string>;
  resourceTexts: Record<string, string>;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const isImage = (r: CelResourceRef) => (r.mediaType ?? '').startsWith('image/');
const isText = (r: CelResourceRef) =>
  /^(application\/json|text\/)/.test(r.mediaType ?? '');

export function OriginalDetail({ did }: { did: string }) {
  const { isAuthenticated } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState<DetailData | null>(null);
  const [checks, setChecks] = useState<OriginalCheck[] | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated) return;
    let live = true;
    setLoaded(false);
    setData(null);
    setChecks(null);

    (async () => {
      const arts = webvhArtifacts(did, window.location.host);
      const [rows, logRaw, celRaw] = await Promise.all([
        fetchOriginals(),
        arts ? fetchText(arts.logUrl) : null,
        arts ? fetchText(arts.celUrl) : null
      ]);
      const row = rows.find((r) => r.did === did) ?? null;

      let logEntries: ReturnType<typeof parseDidLog> | null = null;
      try {
        logEntries = logRaw ? parseDidLog(logRaw) : null;
      } catch {
        logEntries = null;
      }
      let cel: CelLog | null = null;
      try {
        cel = celRaw ? (JSON.parse(celRaw) as CelLog) : null;
      } catch {
        cel = null;
      }

      const resources = celResources(cel);
      const resourceUrls: Record<string, string> = {};
      const resourceTexts: Record<string, string> = {};
      for (const r of resources) {
        // Resources are hosted under the raw-hash multibase, not the CEL's
        // multihash digest — convert declared digest → hosted key segment.
        const hex = r.digestMultibase ? digestMultibaseSha256Hex(r.digestMultibase) : null;
        const hosted = hex ? sha256HexToResourceMultibase(hex) : null;
        if (arts && hosted) resourceUrls[r.id] = arts.resourceUrl(hosted);
      }
      await Promise.all(
        resources.filter(isText).map(async (r) => {
          const url = resourceUrls[r.id];
          if (!url) return;
          const text = await fetchText(url);
          if (text) resourceTexts[r.id] = text;
        })
      );

      if (!live) return;
      setData({
        row,
        cel,
        logEntries,
        logSummary: logEntries ? didLogSummary(logEntries) : null,
        resources,
        resourceUrls,
        resourceTexts
      });
      setLoaded(true);

      // Verification pass — real cryptography, lazy chunk. The primary resource
      // (the artwork) is re-fetched as bytes and re-hashed; both signed chains
      // re-verify locally.
      const primary = resources.find(isImage) ?? resources[0];
      const primaryUrl = primary
        ? resourceUrls[primary.id]
        : row?.resourceUrl && sameOriginUrl(row.resourceUrl, window.location.host);
      const bytes = primaryUrl ? await fetchBytes(primaryUrl) : null;
      const declaredHash =
        (primary?.digestMultibase ? digestMultibaseSha256Hex(primary.digestMultibase) : null) ??
        row?.resourceHash ??
        null;
      try {
        const { verifyOriginal } = await import('../sdk/verify-original');
        const result = await verifyOriginal({
          did,
          logEntries,
          celLog: cel,
          resourceBytes: bytes,
          declaredHash
        });
        if (live) setChecks(result);
      } catch (err) {
        console.error('[originals-sdk] original verification failed', err);
        if (live) setChecks([]);
      }
    })();

    return () => {
      live = false;
    };
  }, [isAuthenticated, did]);

  const mode = detailMode({ authenticated: isAuthenticated, loaded, row: data?.row ?? null });

  const copyDid = async () => {
    try {
      await navigator.clipboard.writeText(did);
    } catch {
      // clipboard can be unavailable — the DID text stays selectable
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const allOk = !!checks && checks.length > 0 && checks.every((c) => c.ok);
  const anyFail = !!checks && (checks.length === 0 || checks.some((c) => !c.ok));

  return (
    <main className="section od">
      <div className="container">
        <a
          className="od-back"
          href="/me"
          onClick={(e) => {
            e.preventDefault();
            navigate('/me');
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {originalDetail.backLabel}
        </a>

        {mode === 'signed-out' && <p className="od-note">{originalDetail.signedOut}</p>}
        {mode === 'loading' && (
          <p className="od-note" role="status">
            <span className="od-pulse" aria-hidden="true" />
            {originalDetail.loading}
          </p>
        )}

        {mode === 'not-found' && (
          <div className="od-empty">
            <p className="od-empty-title">{originalDetail.notFoundTitle}</p>
            <p>{originalDetail.notFoundBody}</p>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/me')}>
              {originalDetail.notFoundCta}
            </button>
          </div>
        )}

        {mode === 'ready' && data?.row && (
          <>
            <Hero did={did} data={data} checks={checks} allOk={allOk} anyFail={anyFail} copied={copied} onCopy={copyDid} />
            {data.cel ? (
              <Timeline steps={celTimeline(data.cel)} />
            ) : (
              <p className="od-note">{originalDetail.artifactsMissing}</p>
            )}
            {data.resources.length > 0 && <Resources data={data} />}
            {data.logSummary && <Identity summary={data.logSummary} />}
            <Artifacts did={did} />
          </>
        )}
      </div>
    </main>
  );
}

/* ——— sections ——— */

function Hero(props: {
  did: string;
  data: DetailData;
  checks: OriginalCheck[] | null;
  allOk: boolean;
  anyFail: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const { did, data, checks, allOk, anyFail, copied, onCopy } = props;
  const row = data.row!;
  const artResource = data.resources.find(isImage);
  const artUrl =
    (artResource && data.resourceUrls[artResource.id]) ??
    (row.resourceUrl ? sameOriginUrl(row.resourceUrl, window.location.host) : undefined);
  const medium = mediumFromMetadata(data);

  return (
    <header className="card od-hero">
      <div className="od-art">
        {artUrl ? (
          <img src={artUrl} alt={`Artwork for “${row.title}”`} />
        ) : (
          <div className="od-art-placeholder" aria-hidden="true" />
        )}
      </div>
      <div className="od-hero-body">
        <div className="od-hero-pills">
          <span className="layer-pill" data-layer="did:webvh">
            <span className="dot" />
            did:webvh
          </span>
          {!checks && (
            <span className="od-badge" data-state="pending">
              <span className="od-pulse" aria-hidden="true" />
              {originalDetail.verifyingBadge}
            </span>
          )}
          {checks && (
            <span className="od-badge" data-state={allOk ? 'ok' : 'warn'}>
              {allOk ? originalDetail.verifiedBadge : originalDetail.failedBadge}
            </span>
          )}
        </div>
        <h1>{row.title}</h1>
        <p className="od-hero-meta">
          {medium && <span>{medium} · </span>}
          {originalDetail.createdLabel} {row.createdAt.slice(0, 10)}
        </p>
        <div className="od-did">
          <code title={did}>{did}</code>
          <button
            type="button"
            className="od-copy"
            data-copied={copied || undefined}
            onClick={onCopy}
            aria-label={copied ? 'DID copied' : 'Copy DID'}
          >
            {copied ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>

        <ul className="od-checks">
          {(['hash', 'log', 'cel'] as const).map((id) => {
            const check = checks?.find((c) => c.id === id);
            const status = !checks ? 'pending' : check?.ok ? 'ok' : 'fail';
            return (
              <li key={id} data-state={status}>
                <span className="od-check-mark" aria-hidden="true">
                  {status === 'ok' ? (
                    <svg viewBox="0 0 16 16">
                      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : status === 'fail' ? (
                    <svg viewBox="0 0 16 16">
                      <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <span className="od-check-dot" />
                  )}
                </span>
                <div>
                  <p className="od-check-label">{originalDetail.checkLabels[id]}</p>
                  {check && <p className="od-check-detail">{check.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="od-verify-note">{originalDetail.verifyNote}</p>
      </div>
    </header>
  );
}

function mediumFromMetadata(data: DetailData): string | null {
  const meta = data.resources.find((r) => r.mediaType === 'application/json');
  const text = meta ? data.resourceTexts[meta.id] : undefined;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { medium?: unknown };
    return typeof parsed.medium === 'string' ? parsed.medium : null;
  } catch {
    return null;
  }
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <section className="od-section">
      <div className="section-head">
        <p className="eyebrow">{originalDetail.timeline.eyebrow}</p>
        <h2>{originalDetail.timeline.heading}</h2>
        <p>{originalDetail.timeline.subhead}</p>
      </div>
      <ol className="od-timeline">
        {steps.map((step) => {
          const copy = originalDetail.timeline.steps[step.id];
          return (
            <li key={step.id} className="od-step" data-state={step.state} data-layer={step.layer}>
              <span className="od-step-node" aria-hidden="true" />
              <div className="card od-step-card">
                <div className="od-step-head">
                  <span className="layer-pill" data-layer={step.layer}>
                    <span className="dot" />
                    {step.layer}
                  </span>
                  <h3>{copy.title}</h3>
                  {step.state === 'done' && step.at ? (
                    <time className="od-step-time" dateTime={step.at}>
                      {step.at.slice(0, 10)} · {step.at.slice(11, 19)} UTC
                    </time>
                  ) : (
                    <span className="od-step-time">{originalDetail.timeline.upcomingLabel}</span>
                  )}
                </div>
                <p className="od-step-blurb">{copy.blurb}</p>
                {step.facts.length > 0 && (
                  <dl className="od-step-facts">
                    {step.facts.map((f) => (
                      <div key={f.label}>
                        <dt>{f.label}</dt>
                        <dd>
                          {f.mono ? <code title={f.value}>{short(f.value, 34, 8)}</code> : f.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {step.proof?.proofValue && (
                  <p className="od-step-proof">
                    <span className="od-step-proof-label">{originalDetail.timeline.proofLabel}</span>
                    <code title={step.proof.proofValue}>
                      {step.proof.cryptosuite ?? 'proof'} · {short(step.proof.proofValue, 18, 6)}
                    </code>
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Resources({ data }: { data: DetailData }) {
  return (
    <section className="od-section">
      <div className="section-head">
        <h2>{originalDetail.resources.heading}</h2>
        <p>{originalDetail.resources.subhead}</p>
      </div>
      <div className="od-resources">
        {data.resources.map((r) => {
          const url = data.resourceUrls[r.id];
          const text = data.resourceTexts[r.id];
          return (
            <article key={r.id} className="card od-resource">
              <div className="od-resource-preview">
                {isImage(r) && url ? (
                  <img src={url} alt={`Resource ${r.id}`} />
                ) : text ? (
                  <pre>{prettyJson(text)}</pre>
                ) : (
                  <div className="od-art-placeholder" aria-hidden="true" />
                )}
              </div>
              <div className="od-resource-body">
                <h3>
                  <code>{r.id}</code>
                </h3>
                <dl className="od-resource-facts">
                  {r.mediaType && (
                    <div>
                      <dt>{originalDetail.resources.typeLabel}</dt>
                      <dd>
                        <code>{r.mediaType}</code>
                      </dd>
                    </div>
                  )}
                  {r.digestMultibase && (
                    <div>
                      <dt>{originalDetail.resources.digestLabel}</dt>
                      <dd>
                        <code title={r.digestMultibase}>{short(r.digestMultibase, 20, 6)}</code>
                      </dd>
                    </div>
                  )}
                </dl>
                {url && (
                  <a className="od-raw-link" href={url} target="_blank" rel="noreferrer">
                    {originalDetail.resources.openRaw}
                    <ExternalIcon />
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Identity({ summary }: { summary: DidLogSummary }) {
  const vm = summary.verificationMethods[0];
  return (
    <section className="od-section">
      <div className="section-head">
        <h2>{originalDetail.identity.heading}</h2>
        <p>{originalDetail.identity.subhead}</p>
      </div>
      <div className="card od-identity">
        <dl className="od-identity-kv">
          {summary.did && (
            <div>
              <dt>{originalDetail.identity.did}</dt>
              <dd>
                <code title={summary.did}>{summary.did}</code>
              </dd>
            </div>
          )}
          {summary.scid && (
            <div>
              <dt>{originalDetail.identity.scid}</dt>
              <dd>
                <code title={summary.scid}>{short(summary.scid, 24, 6)}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>{originalDetail.identity.versions}</dt>
            <dd>{summary.versions}</dd>
          </div>
          {summary.updatedAt && (
            <div>
              <dt>{originalDetail.identity.updated}</dt>
              <dd>{summary.updatedAt.slice(0, 10)}</dd>
            </div>
          )}
          {summary.updateKeys[0] && (
            <div>
              <dt>{originalDetail.identity.updateKey}</dt>
              <dd>
                <code title={summary.updateKeys[0]}>{short(summary.updateKeys[0], 24, 6)}</code>
              </dd>
            </div>
          )}
          {vm?.publicKeyMultibase && (
            <div>
              <dt>{originalDetail.identity.signingKey}</dt>
              <dd>
                <code title={vm.publicKeyMultibase}>{short(vm.publicKeyMultibase, 24, 6)}</code>
              </dd>
            </div>
          )}
        </dl>
        {summary.document && (
          <details className="od-doc">
            <summary>{originalDetail.identity.documentToggle}</summary>
            <pre>{JSON.stringify(summary.document, null, 2)}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

function Artifacts({ did }: { did: string }) {
  const arts = webvhArtifacts(did, typeof window !== 'undefined' ? window.location.host : undefined);
  if (!arts) return null;
  const links = [
    { href: arts.logUrl, label: originalDetail.artifacts.logLabel },
    { href: arts.celUrl, label: originalDetail.artifacts.celLabel }
  ];
  return (
    <section className="od-section">
      <div className="section-head">
        <h2>{originalDetail.artifacts.heading}</h2>
        <p>{originalDetail.artifacts.subhead}</p>
      </div>
      <ul className="od-artifacts">
        {links.map((l) => (
          <li key={l.href}>
            <a className="od-raw-link" href={l.href} target="_blank" rel="noreferrer">
              <code>{l.href.replace(/^https?:\/\//, '')}</code>
              <span>{l.label}</span>
              <ExternalIcon />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
      <path d="M6 3h7v7M13 3 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
