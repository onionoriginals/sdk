import { useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import './identity-panel.css';

/**
 * Signed-in conversion moment: create your did:webvh, then reveal it.
 * Renders nothing when signed out so the hero stays untouched.
 */
export function IdentityPanel() {
  const { isAuthenticated, createIdentity } = useAuth();
  const [creating, setCreating] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  if (!isAuthenticated) return null;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      setDid(await createIdentity());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'DID creation failed — try again.');
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!did) return;
    try {
      await navigator.clipboard.writeText(did);
    } catch {
      // clipboard can be unavailable — the DID text stays selectable
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
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
            <span className="idp-done-title">Your identity is live</span>
            <span className="layer-pill" data-layer="did:webvh">
              <span className="dot" />
              did:webvh
            </span>
          </div>
          <div className="idp-did">
            <code title={did}>{did}</code>
            <button
              type="button"
              className="idp-copy-btn"
              data-copied={copied || undefined}
              onClick={copy}
              aria-label={copied ? 'DID copied' : 'Copy DID'}
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
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className="idp-done-note">Anchored to your keys. Resolvable anywhere DIDs are.</p>
        </div>
      ) : (
        <>
          <div className="idp-row">
            <div className="idp-lede">
              <span className="layer-pill" data-layer="did:webvh">
                <span className="dot" />
                did:webvh
              </span>
              <h2 className="idp-title">Your identity, on the open web</h2>
              <p className="idp-sub">
                Mint a resolvable DID signed by your own keys — yours to keep, verify, and build on.
              </p>
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
              {creating ? 'Creating…' : 'Create your did:webvh'}
            </button>
          </div>
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
