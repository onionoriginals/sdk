import { useRef, useState } from 'react';
import { site } from '../content';
import './install-command.css';

/** Copyable `npm install @originals/sdk` chip. */
export function InstallCommand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(site.install);
    } catch {
      // clipboard can be unavailable (permissions, http) — select-able text remains
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      className="install-cmd"
      data-size={size}
      onClick={copy}
      aria-label={`Copy ${site.install}`}
    >
      <span className="install-prompt" aria-hidden="true">
        $
      </span>
      <code>{site.install}</code>
      <span className="install-copy" data-copied={copied || undefined}>
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
            <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        )}
        <span className="install-copy-label">{copied ? 'Copied' : 'Copy'}</span>
      </span>
    </button>
  );
}
