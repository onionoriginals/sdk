import { hero } from '../content';
import { Eclipse } from './Eclipse';
import { IdentityPanel } from './IdentityPanel';
import { goToSection } from '../router';
import { KeepLastWord } from './KeepLastWord';

export function Hero() {
  const { evidence } = hero;
  return (
    <section className="hero eclipse-hero" id="top">
      <div className="container eclipse-hero-grid">
        <div className="eclipse-hero-copy">
          <h1 className="eclipse-display"><KeepLastWord text={hero.headline} /></h1>
          <p className="eclipse-lede">{hero.subhead}</p>
          <div className="eclipse-actions">
            <a
              className="btn btn-primary btn-mark"
              href={hero.primaryCta.href}
              onClick={(e) => { e.preventDefault(); goToSection(hero.primaryCta.href); }}
            >
              <span className="btn-ring" aria-hidden="true" />
              {hero.primaryCta.label}
            </a>
            <a
              className="eclipse-quiet"
              href={hero.exampleLink.href}
              onClick={(e) => { e.preventDefault(); goToSection(hero.exampleLink.href); }}
            >
              {hero.exampleLink.label}
            </a>
          </div>
          <IdentityPanel />
        </div>
        <figure className="eclipse-sky">
          <div className="eclipse-scene"><Eclipse className="eclipse-canvas" /></div>
          <figcaption className="eclipse-evidence">
            <span className="eclipse-evidence-caption">{evidence.caption}</span>
            <ul>
              {evidence.events.map((event) => (
                <li key={event.label} data-done={event.done || undefined}>
                  <span>{event.label}</span>
                  <time>{event.value}</time>
                </li>
              ))}
            </ul>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
