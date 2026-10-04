import { hero } from '../content';
import { IdentityPanel } from './IdentityPanel';
import { SplitMark } from './SplitMark';

export function Hero() {
  const copy = hero.imprint;
  return (
    <section className="hero press-hero" id="top">
      <div className="container press-grid">
        <div className="press-copy">
          <p className="press-kicker">{copy.eyebrow}</p>
          <h1 className="hero-headline press-headline">
            {copy.headline.map((line) => <span key={line}>{line}</span>)}
          </h1>
          <p className="press-promise">{copy.promise.map((line) => <span key={line}>{line}</span>)}</p>
          <div className="press-actions">
            <a className="btn btn-primary" href={hero.primaryCta.href}>
              {hero.primaryCta.label}<span aria-hidden="true">↗</span>
            </a>
            <p>{copy.note}</p>
          </div>
          <IdentityPanel />
        </div>
        <figure className="press-proof">
          <div className="press-proof-inner">
            <p className="press-proof-label">{copy.recordLabel}</p>
            <SplitMark />
            <figcaption>
              <span>{copy.filename}</span>
              <strong>{copy.recordTitle}</strong>
              <span>{copy.illustrationNote}</span>
            </figcaption>
            <span className="press-stamp" aria-hidden="true">{copy.stamp}</span>
          </div>
        </figure>
      </div>
    </section>
  );
}
