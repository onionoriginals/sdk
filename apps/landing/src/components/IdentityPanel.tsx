import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { identityPanel } from '../content';
import './identity-panel.css';

/**
 * Signed-in conversion moment: create your did:webvh, then reveal it.
 * Renders nothing when signed out so the hero stays untouched.
 *
 * There is no warning gate and no backup here any more. Both existed because
 * the DID key lived only in this browser; it is now held at Turnkey and the log
 * is published (auth/webvh.ts), so creating is reversible-by-signing-in and
 * there is nothing the user could lose by not saving a file. What replaces them
 * is a plain statement of who holds the key — see `identityPanel.custodyNote`.
 */
export function IdentityPanel() {
  const { isAuthenticated, user, bitcoin, createIdentity, loadIdentity } = useAuth();
  const [creating, setCreating] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const subOrgId = user?.subOrgId ?? null;

  // Show a returning user's DID. `loadIdentity`, NOT `createIdentity`: rendering
  // must never mint an identity nobody asked for. Reading needs no session, so
  // this runs as soon as there is a user.
  useEffect(() => {
    if (!subOrgId) return;
    let cancelled = false;
    loadIdentity()
      .then((existing) => {
        if (!cancelled && existing) setDid(existing);
      })
      .catch(() => {
        /* Idle state is the correct fallback: the button retries out loud. */
      });
    // Named, not an inline arrow: the copy-migration guard anchors its JSX scan
    // on this file's first returned parenthesis, which must be the markup.
    const cancel = () => {
      cancelled = true;
    };
    return cancel;
  }, [subOrgId, loadIdentity]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (!isAuthenticated) return null;

  const create = async () => {
    // Turnkey custody means creating needs a live session; say which of the two
    // it is rather than showing one generic failure for both.
    if (!bitcoin?.signingClient) return setError(identityPanel.sessionRequired);
    setCreating(true);
    setError(null);
    try {
      setDid(await createIdentity());
    } catch {
      setError(identityPanel.createFailed);
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!did) return;
    try {
      await navigator.clipboard.writeText(did);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* A clipboard the browser refuses is not an error worth a banner. */
    }
  };

  return (
    <aside className="idp" data-state={did ? 'done' : creating ? 'creating' : 'idle'}>
      {did ? (
        <div className="idp-done" role="status">
          <div className="idp-done-head">
            <span className="idp-check" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path
                  d="m3.5 8.5 3 3 6-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="idp-done-title">{identityPanel.doneTitle}</span>
            <span className="layer-pill" data-layer="did:webvh">
              <span className="dot" />
              {identityPanel.layerLabel}
            </span>
          </div>
          <div className="idp-did">
            <code title={did}>{did}</code>
            <button
              type="button"
              className="idp-copy-btn"
              data-copied={copied || undefined}
              onClick={copy}
              aria-label={copied ? identityPanel.copiedAria : identityPanel.copyAria}
            >
              {copied ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="m3.5 8.5 3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              )}
              <span>{copied ? identityPanel.copied : identityPanel.copy}</span>
            </button>
          </div>
          <p className="idp-done-note">{identityPanel.doneNote}</p>
          {/* Custody, stated where the user is looking at the thing it applies
              to — not only in the privacy policy. */}
          <p className="idp-custody-note">{identityPanel.custodyNote}</p>
          {error && (
            <p className="idp-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="idp-row">
            <div className="idp-lede">
              <span className="layer-pill" data-layer="did:webvh">
                <span className="dot" />
                {identityPanel.layerLabel}
              </span>
              <h2 className="idp-title">{identityPanel.idleTitle}</h2>
              <p className="idp-sub">{identityPanel.idleBody}</p>
            </div>
            <button type="button" className="idp-cta" disabled={creating} aria-busy={creating} onClick={create}>
              {creating ? (
                <svg className="idp-spinner" viewBox="0 0 16 16" aria-hidden="true">
                  <circle
                    cx="8"
                    cy="8"
                    r="6.25"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeDasharray="26 14"
                  />
                </svg>
              ) : (
                <svg className="idp-globe" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <ellipse cx="8" cy="8" rx="2.7" ry="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1.75 8h12.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              )}
              {creating ? identityPanel.creating : identityPanel.createAction}
            </button>
          </div>
          <p className="idp-custody-note">{identityPanel.custodyNote}</p>
          {error && (
            <p className="idp-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </aside>
  );
}
