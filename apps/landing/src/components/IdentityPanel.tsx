import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { identityPanel } from '../content';
import {
  AuthorshipKeyError,
  acknowledgeKeyLoss,
  backupFileName,
  browserKeyStorage,
  didFromLog,
  exportAuthorshipKey,
  hasAuthorshipKey,
  importAuthorshipKey,
  parseBackupFile,
  passphraseProblem,
  readAuthorshipKey,
} from '../auth/authorship-key';
import './identity-panel.css';

/**
 * Signed-in conversion moment: create your did:webvh, then reveal it.
 * Renders nothing when signed out so the hero stays untouched.
 *
 * U10 / R17: creating is gated on the key-loss warning. The key that signs
 * every Original the user makes exists only in this browser, so the warning
 * has to land before it is generated — one click used to be the whole step.
 * R18: the done state carries the export, and the idle state the restore.
 */
export function IdentityPanel() {
  const { isAuthenticated, user, createIdentity } = useAuth();
  const [stage, setStage] = useState<'idle' | 'warning' | 'backup' | 'restore'>('idle');
  const [creating, setCreating] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [acknowledged, setAcknowledged] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [repeated, setRepeated] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [replaceOk, setReplaceOk] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const subOrgId = user?.subOrgId ?? null;
  const [holdsKey, setHoldsKey] = useState(false);

  // A returning user already has both halves in storage: show the finished
  // state (and its reminder) rather than offering to create a second identity.
  useEffect(() => {
    const storage = browserKeyStorage();
    if (!storage || !subOrgId) return;
    setHoldsKey(hasAuthorshipKey(storage, subOrgId));
    const stored = readAuthorshipKey(storage, subOrgId);
    if (stored) setDid(didFromLog(stored.didLog));
  }, [subOrgId]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (!isAuthenticated) return null;

  const resetForm = () => {
    setPassphrase('');
    setRepeated('');
    setReplaceOk(false);
    setError(null);
    setNotice(null);
  };

  const openWarning = () => {
    resetForm();
    setAcknowledged(false);
    setStage('warning');
  };

  const openStage = (next: 'backup' | 'restore') => {
    resetForm();
    setStage(next);
  };

  const closeStage = () => {
    resetForm();
    setStage('idle');
  };

  /** The acknowledgement IS the gate: `createUserWebVHDid` refuses without it. */
  const confirmAndCreate = async () => {
    const storage = browserKeyStorage();
    if (!storage || !subOrgId || !acknowledged) return;
    acknowledgeKeyLoss(storage, subOrgId);
    setCreating(true);
    setError(null);
    try {
      const created = await createIdentity();
      setDid(created);
      setHoldsKey(true);
      setStage('idle');
    } catch (e) {
      setError(
        e instanceof AuthorshipKeyError
          ? identityPanel.warning.notAcknowledged
          : e instanceof Error
            ? e.message
            : identityPanel.createFailed
      );
    } finally {
      setCreating(false);
    }
  };

  const saveBackup = async () => {
    const storage = browserKeyStorage();
    if (!storage || !subOrgId) return;
    if (passphrase !== repeated) return setError(identityPanel.backup.mismatch);
    if (passphraseProblem(passphrase)) return setError(identityPanel.backup.weak);
    setBusy(true);
    setError(null);
    try {
      const file = await exportAuthorshipKey(storage, subOrgId, passphrase);
      download(JSON.stringify(file, null, 2), backupFileName());
      setPassphrase('');
      setRepeated('');
      setNotice(identityPanel.backup.done);
    } catch {
      setError(identityPanel.backup.failed);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const storage = browserKeyStorage();
    if (!storage || !subOrgId) return;
    const chosen = fileInput.current?.files?.[0];
    if (!chosen) return setError(identityPanel.restore.noFile);
    setBusy(true);
    setError(null);
    try {
      const file = parseBackupFile(await chosen.text());
      const result = await importAuthorshipKey(storage, subOrgId, file, passphrase, {
        allowReplace: replaceOk,
      });
      setDid(result.did);
      setHoldsKey(true);
      setPassphrase('');
      setNotice(identityPanel.restore.done);
      setStage('idle');
    } catch (e) {
      setError(restoreMessage(e));
    } finally {
      setBusy(false);
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

  const passphraseField = (id: string, label: string, value: string, onChange: (v: string) => void) => (
    <label className="idp-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        placeholder={identityPanel.backup.passphrasePlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );

  return (
    <aside className="idp" data-state={did ? 'done' : creating ? 'creating' : stage}>
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
          {/* R9: this DID is signed and stored in this browser (auth/webvh.ts)
              and hosted nowhere, so the note says that instead of the old
              "Anchored to your keys. Resolvable anywhere DIDs are." */}
          <p className="idp-done-note">{identityPanel.doneNote}</p>
          {/* R17: the same warning, restated every time a returning user lands here. */}
          <p className="idp-warn-note">{identityPanel.warning.reminder}</p>
          {stage === 'backup' ? (
            <div className="idp-form">
              <h3 className="idp-form-title">{identityPanel.backup.title}</h3>
              <p className="idp-form-body">{identityPanel.backup.body}</p>
              {passphraseField('idp-pass', identityPanel.backup.passphraseLabel, passphrase, setPassphrase)}
              {passphraseField('idp-pass-2', identityPanel.backup.confirmLabel, repeated, setRepeated)}
              <div className="idp-form-actions">
                <button type="button" className="idp-cta idp-cta-sm" disabled={busy} aria-busy={busy} onClick={saveBackup}>
                  {busy ? identityPanel.backup.working : identityPanel.backup.action}
                </button>
                <button type="button" className="idp-ghost" onClick={closeStage}>
                  {identityPanel.backup.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="idp-form-actions">
              <button type="button" className="idp-ghost idp-ghost-key" onClick={() => openStage('backup')}>
                {identityPanel.backup.open}
              </button>
            </div>
          )}
          {notice && <p className="idp-notice">{notice}</p>}
          {error && (
            <p className="idp-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : stage === 'warning' ? (
        <div className="idp-form idp-warning">
          <h2 className="idp-form-title">{identityPanel.warning.title}</h2>
          <p className="idp-form-body">{identityPanel.warning.body}</p>
          <p className="idp-form-body">{identityPanel.warning.remedy}</p>
          <label className="idp-check-row">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{identityPanel.warning.acknowledge}</span>
          </label>
          <div className="idp-form-actions">
            <button
              type="button"
              className="idp-cta idp-cta-sm"
              disabled={!acknowledged || creating}
              aria-busy={creating}
              onClick={confirmAndCreate}
            >
              {creating ? identityPanel.creating : identityPanel.warning.confirm}
            </button>
            <button type="button" className="idp-ghost" onClick={closeStage}>
              {identityPanel.warning.cancel}
            </button>
          </div>
          {error && (
            <p className="idp-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : stage === 'restore' ? (
        <div className="idp-form">
          <h2 className="idp-form-title">{identityPanel.restore.title}</h2>
          <p className="idp-form-body">{identityPanel.restore.body}</p>
          <label className="idp-field" htmlFor="idp-file">
            <span>{identityPanel.restore.fileLabel}</span>
            <input id="idp-file" ref={fileInput} type="file" accept="application/json,.json" />
          </label>
          {passphraseField('idp-restore-pass', identityPanel.restore.passphraseLabel, passphrase, setPassphrase)}
          {holdsKey && (
            <div className="idp-replace" role="alert">
              <strong>{identityPanel.restore.replaceTitle}</strong>
              <p>{identityPanel.restore.replaceBody}</p>
              <label className="idp-check-row">
                <input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} />
                <span>{identityPanel.restore.replaceAcknowledge}</span>
              </label>
            </div>
          )}
          <div className="idp-form-actions">
            <button
              type="button"
              className="idp-cta idp-cta-sm"
              disabled={busy || (holdsKey && !replaceOk)}
              aria-busy={busy}
              onClick={restore}
            >
              {busy ? identityPanel.restore.working : identityPanel.restore.action}
            </button>
            <button type="button" className="idp-ghost" onClick={closeStage}>
              {identityPanel.restore.cancel}
            </button>
          </div>
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
            <button type="button" className="idp-cta" disabled={creating} aria-busy={creating} onClick={openWarning}>
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
          <div className="idp-form-actions">
            <button type="button" className="idp-ghost idp-ghost-key" onClick={() => openStage('restore')}>
              {identityPanel.restore.open}
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

function restoreMessage(e: unknown): string {
  const code = e instanceof AuthorshipKeyError ? e.code : null;
  if (code === 'wrong-passphrase') return identityPanel.restore.wrongPassphrase;
  if (code === 'malformed-backup') return identityPanel.restore.malformed;
  if (code === 'replace-not-acknowledged') return identityPanel.restore.replaceBlocked;
  return identityPanel.restore.failed;
}

/**
 * Hand the file to the browser without a round trip: an object URL over an
 * in-memory Blob, clicked and revoked. A download is not a fetch, so the strict
 * document CSP (U6) governs none of this and needs no `blob:` allowance.
 */
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
