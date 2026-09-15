import { useEffect, useState } from 'react';
import type { PublishedOriginal } from '../../shared/explore';
import type { OriginalCheck } from '../sdk/verify-original';
import type { AssetResolution, OrdinalsProvider } from '@originals/sdk';
import { explore as copy } from '../content';
import { parseDidLog, digestMultibaseSha256Hex } from './original-detail-data';
import { OriginalArtwork, publicationDate } from './Explore';

/**
 * A fresh Bitcoin provider snapshot resolved through the real SDK, never a
 * server-asserted summary. Kept separate from the hash/log/cel checks
 * (see the effect below) — a Bitcoin node observation can take up to its
 * full deadline, and that must never block the fast local checks from
 * appearing.
 */
async function resolveBtco(
  sat: string,
  expectedAssetId: string,
): Promise<AssetResolution> {
  const [{ OriginalsSDK }, { PublicSatSnapshotProvider }] = await Promise.all([
    import('@originals/sdk'),
    import('../sdk/public-sat-provider'),
  ]);
  const publicProvider = new PublicSatSnapshotProvider();
  const snapshot = await publicProvider.getSatSnapshot(sat);
  const provider: OrdinalsProvider = publicProvider;
  // One frozen snapshot for the whole resolution — never a second,
  // potentially different, live fetch mid-check.
  const frozenProvider = { ...provider, getSatSnapshot: async () => snapshot };
  const sdk = OriginalsSDK.create({
    network: snapshot.network,
    ordinalsProvider: frozenProvider,
  });
  return sdk.lifecycle.resolveAssetFromSat(sat, { expectedAssetId });
}

export function ExploreOriginal({ did }: { did: string }) {
  const [original, setOriginal] = useState<PublishedOriginal | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'missing' | 'error'
  >('loading');
  const [checks, setChecks] = useState<OriginalCheck[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    setStatus('loading');
    setOriginal(null);
    setChecks(null);
    (async () => {
      const response = await fetch(
        '/api/explore/original?' + new URLSearchParams({ did }),
        { signal: abort.signal },
      );
      if (!live) return;
      if (response.status === 404) {
        setStatus('missing');
        return;
      }
      if (!response.ok) throw new Error('unavailable');
      const { original: row } = (await response.json()) as {
        original: PublishedOriginal;
      };
      if (!live) return;
      setOriginal(row);
      setStatus('ready');
      try {
        const read = async (url: string) => {
          const r = await fetch(url, { signal: abort.signal });
          if (!r.ok) throw new Error('artifact unavailable');
          return r;
        };
        const [log, cel, resource] = await Promise.all([
          read(row.logUrl),
          read(row.celUrl),
          row.resourceUrl ? read(row.resourceUrl) : Promise.resolve(null),
        ]);
        const { verifyOriginal, evaluateBtcoCheck } =
          await import('../sdk/verify-original');
        const { validateDocument, verifyHistory } =
          await import('@originals/sdk/cel');
        const celLog = validateDocument(await cel.json());
        const state = verifyHistory(celLog).state;
        if (!state.active) throw new Error('inactive publication');
        const digest = state.resources[0]?.digestMultibase;
        // Kick the (potentially slow) Bitcoin resolution off now, but do not
        // await it here — a node observation can take up to its own full
        // deadline, and it must never delay the fast local checks below from
        // appearing. It is awaited separately further down.
        const btcoPromise = row.sat
          ? resolveBtco(row.sat, state.assetId).catch((err) => {
              console.error(
                '[originals-sdk] explore Bitcoin verification failed',
                err,
              );
              return null;
            })
          : null;
        const result = await verifyOriginal({
          did,
          logEntries: parseDidLog(await log.text()),
          celLog,
          resourceBytes: resource
            ? new Uint8Array(await resource.arrayBuffer())
            : null,
          declaredHash: digest ? digestMultibaseSha256Hex(digest) : null,
        });
        // Do not publish the local checks on their own: the "Verified" badge
        // reads `checks.every(ok)`, so setting them before the Bitcoin check
        // exists would let an unmigrated-looking pass show as fully verified
        // for the whole (potentially slow) Bitcoin round-trip. Build the full
        // batch — appending the "btco" check when applicable — and publish it
        // once, keeping `checks === null` (the existing "checking" state)
        // until every applicable check has actually run.
        let nextChecks = result;
        if (row.sat && btcoPromise) {
          const btcoResolution = await btcoPromise;
          if (!live) return;
          const btcoCheck = evaluateBtcoCheck({
            sat: row.sat,
            celVerified: result.find((c) => c.id === 'cel')?.ok ?? false,
            assetId: state.assetId,
            controller: state.controller,
            resolution: btcoResolution,
          });
          nextChecks = [...result, btcoCheck];
        }
        if (live) setChecks(nextChecks);
      } catch {
        if (live) setChecks([]);
      }
    })().catch(() => {
      if (live) setStatus('error');
    });
    return () => {
      live = false;
      abort.abort();
    };
  }, [did, attempt]);
  const bitcoinCheck = checks?.find((check) => check.id === 'btco');
  const verified =
    checks !== null && checks.length > 0 && checks.every((check) => check.ok);
  return (
    <main className="container explore-page explore-detail">
      <a className="explore-back" href="/explore">
        ← {copy.back}
      </a>
      {status === 'loading' && <p role="status">{copy.loading}</p>}
      {status === 'missing' && <h1>{copy.missing}</h1>}
      {status === 'error' && (
        <div role="alert">
          <p>{copy.unavailable}</p>
          <button
            className="btn"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {copy.retry}
          </button>
        </div>
      )}
      {status === 'ready' && original && (
        <>
          <div className="explore-detail-grid">
            <div className="explore-detail-art">
              <OriginalArtwork original={original} />
            </div>
            <header className="explore-detail-info">
              <p className="eyebrow">
                {copy.created} · {publicationDate(original.createdAt)}
              </p>
              <h1>{original.title}</h1>
              <p>
                {original.resourceCount}{' '}
                {original.resourceCount === 1
                  ? copy.file.toLowerCase()
                  : copy.files}{' '}
                · {original.resourceContentType}
              </p>
              <div
                className="explore-verification"
                data-verified={verified}
                role="status"
              >
                <span aria-hidden="true">{verified ? '✓' : '◎'}</span>
                {checks === null
                  ? copy.checking
                  : verified
                    ? copy.checked
                    : copy.incomplete}
              </div>
              <p className="explore-check-note">{copy.checkNote}</p>
              {original.resourceUrl && (
                <a
                  className="btn"
                  href={original.resourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {copy.resources} ↗
                </a>
              )}
            </header>
          </div>
          <section className="explore-provenance">
            <div>
              <p className="eyebrow">{copy.history}</p>
              <h2>{copy.openHistory}</h2>
            </div>
            <dl>
              <div>
                <dt>{copy.controller}</dt>
                <dd>{original.controller}</dd>
              </div>
              <div>
                <dt>{copy.identity}</dt>
                <dd>{original.assetId}</dd>
              </div>
              <div>
                <dt>{copy.hostedIdentity}</dt>
                <dd>{original.did}</dd>
              </div>
              {original.sat && (
                <div>
                  <dt>{bitcoinCheck?.ok ? copy.bitcoin : copy.bitcoinHint}</dt>
                  <dd>
                    sat {original.sat}
                    {bitcoinCheck && <p>{bitcoinCheck.detail}</p>}
                  </dd>
                </div>
              )}
              <div>
                <dt>{copy.log}</dt>
                <dd>
                  <a href={original.logUrl} target="_blank" rel="noreferrer">
                    did.jsonl ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt>{copy.cel}</dt>
                <dd>
                  <a href={original.celUrl} target="_blank" rel="noreferrer">
                    cel.json ↗
                  </a>
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </main>
  );
}
