import { developers } from '../content';
import { InstallCommand } from './InstallCommand';
import { Reveal } from './Reveal';
import './developers.css';

export function Developers() {
  return (
    <section className="section developers" id={developers.id}>
      <div className="container">
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
          <p className="dev-note">
            {developers.sdkNote}{' '}
            <a href={developers.docsLink.href} target="_blank" rel="noreferrer">
              {developers.docsLink.label}
            </a>
          </p>
          <p className="dev-note dev-note-version">{developers.versionNote}</p>
        </Reveal>
      </div>
    </section>
  );
}
