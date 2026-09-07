import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ExplorePage, PublishedOriginal } from '../../shared/explore';
import { explore as copy } from '../content';
import { exploreOriginalPath } from '../router';
import './explore.css';

export function publicationDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
}
export function OriginalArtwork({ original }: { original: PublishedOriginal }) {
  const container = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const image = original.resourceContentType?.startsWith('image/');
  useEffect(() => {
    setSource(null);
    setFailed(false);
    if (!image || !original.resourceUrl || !container.current) return;
    const abort = new AbortController();
    let live = true;
    let objectUrl: string | undefined;
    // Published resources intentionally arrive as octet-stream attachments.
    // Hash the bytes before assigning the signed image MIME to an image-only blob.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        (async () => {
          const response = await fetch(original.resourceUrl!, {
            signal: abort.signal,
          });
          if (!response.ok) throw new Error('image unavailable');
          const bytes = await response.arrayBuffer();
          const { sha256 } = await import('@noble/hashes/sha2.js');
          const hash = Array.from(sha256(new Uint8Array(bytes)), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
          if (hash !== original.resourceHash)
            throw new Error('image digest mismatch');
          if (!live) return;
          objectUrl = URL.createObjectURL(
            new Blob([bytes], { type: original.resourceContentType }),
          );
          setSource(objectUrl);
        })().catch(() => {
          if (live) setFailed(true);
        });
      },
      { rootMargin: '300px' },
    );
    observer.observe(container.current);
    return () => {
      live = false;
      abort.abort();
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    image,
    original.resourceUrl,
    original.resourceHash,
    original.resourceContentType,
  ]);
  return (
    <div ref={container} className="explore-artwork">
      {source && !failed ? (
        <img
          src={source}
          alt={original.title}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="explore-file">
          <span aria-hidden="true">↗</span>
          <span>{original.resourceContentType ?? copy.file}</span>
          <strong>{original.title}</strong>
        </div>
      )}
    </div>
  );
}

export function Explore() {
  const [query, setQuery] = useState(() =>
    (new URLSearchParams(location.search).get('q') ?? '').slice(0, 150),
  );
  const [input, setInput] = useState(query);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ExplorePage>({
    originals: [],
    total: 0,
    nextOffset: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    setLoading(true);
    setError(false);
    fetch(
      `/api/explore?${new URLSearchParams({ q: query, offset: String(offset), limit: '24' })}`,
      { signal: abort.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        return (await response.json()) as ExplorePage;
      })
      .then((result) => {
        if (live)
          setPage((previous) => ({
            ...result,
            originals: offset
              ? [
                  ...previous.originals,
                  ...result.originals.filter(
                    (row) =>
                      !previous.originals.some((old) => old.did === row.did),
                  ),
                ]
              : result.originals,
          }));
      })
      .catch(() => {
        if (live) setError(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      abort.abort();
    };
  }, [query, offset, attempt]);
  function search(event?: FormEvent, next = input) {
    event?.preventDefault();
    const q = next.trim();
    setInput(q);
    setQuery(q);
    setOffset(0);
    setAttempt((value) => value + 1);
    setPage({ originals: [], total: 0, nextOffset: null });
    history.replaceState(
      {},
      '',
      '/explore' + (q ? '?' + new URLSearchParams({ q }) : ''),
    );
  }
  return (
    <main className="container explore-page">
      <header className="explore-intro">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
        </div>
        <p>{copy.intro}</p>
      </header>
      <div className="explore-toolbar">
        <form role="search" onSubmit={search}>
          <label className="sr-only" htmlFor="explore-search">
            {copy.searchLabel}
          </label>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              cx="10.5"
              cy="10.5"
              r="6.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="m16 16 5 5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <input
            id="explore-search"
            type="search"
            maxLength={150}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={copy.searchPlaceholder}
          />
          <button type="submit">{copy.searchButton}</button>
        </form>
        <span className="explore-order">{copy.newest}</span>
      </div>
      <div className="explore-count" aria-live="polite">
        {loading && !page.originals.length
          ? copy.loading
          : !error &&
            `${page.total} ${page.total === 1 ? 'Original' : 'Originals'}${query ? ` · “${query}”` : ''}`}
      </div>
      {error && (
        <div className="explore-message" role="alert">
          <p>{copy.unavailable}</p>
          <button
            className="btn"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {copy.retry}
          </button>
        </div>
      )}
      {!loading && !error && page.originals.length === 0 && (
        <div className="explore-empty">
          <span aria-hidden="true">◎</span>
          <h2>{query ? copy.noResults : copy.emptyTitle}</h2>
          <p>{query ? '' : copy.emptyBody}</p>
          {query ? (
            <button className="btn" onClick={() => search(undefined, '')}>
              {copy.clear}
            </button>
          ) : (
            <a className="btn btn-primary" href="/#demo">
              {copy.create}
            </a>
          )}
        </div>
      )}
      <ol className="explore-grid" aria-busy={loading}>
        {page.originals.map((original, index) => (
          <li key={original.did}>
            <a
              className="explore-work"
              href={exploreOriginalPath(original.did)}
              aria-label={`${copy.open}: ${original.title}`}
            >
              <div className="explore-cover">
                <OriginalArtwork original={original} />
                <span className="explore-open" aria-hidden="true">
                  ↗
                </span>
              </div>
              <div className="explore-caption">
                <span className="explore-index">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h2>{original.title}</h2>
                  <p>
                    {publicationDate(original.createdAt)}
                    <span aria-hidden="true"> · </span>
                    {original.resourceCount}{' '}
                    {original.resourceCount === 1
                      ? copy.file.toLowerCase()
                      : copy.files}
                  </p>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ol>
      {(page.nextOffset !== null || (loading && page.originals.length > 0)) && (
        <div className="explore-more">
          <button
            className="btn"
            disabled={loading}
            onClick={() => setOffset(page.nextOffset!)}
          >
            {loading ? copy.loadingMore : copy.loadMore}
          </button>
          <p>
            {page.originals.length} / {page.total}
          </p>
        </div>
      )}
    </main>
  );
}
