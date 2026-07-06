import { useRef, useState } from 'react';
import { developers } from '../content';
import { InstallCommand } from './InstallCommand';
import { Reveal } from './Reveal';
import { highlight } from './highlight';
import './developers.css';

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore — text remains selectable
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <figure className="codeblock">
      <figcaption className="codeblock-bar">
        <span className="codeblock-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="codeblock-label">{label}</span>
        <button type="button" className="codeblock-copy" data-copied={copied || undefined} onClick={copy}>
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
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre tabIndex={0}>
        <code>{highlight(code)}</code>
      </pre>
    </figure>
  );
}

export function Developers() {
  return (
    <section className="section developers" id={developers.id}>
      <div className="container">
        <div className="dev-grid">
          <Reveal className="dev-copy">
            <p className="eyebrow">{developers.eyebrow}</p>
            <h2>{developers.headline}</h2>
            <p className="dev-subhead">{developers.subhead}</p>
            <ul className="dev-bullets">
              {developers.bullets.map((bullet) => (
                <li key={bullet}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="dev-install">
              <span className="dev-install-label">{developers.installLabel}</span>
              <InstallCommand />
            </div>
          </Reveal>
          <Reveal delay={100} className="dev-code">
            <CodeBlock label="quickstart.ts" code={developers.quickstart} />
            <CodeBlock label={developers.eventsLabel} code={developers.eventsSnippet} />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
