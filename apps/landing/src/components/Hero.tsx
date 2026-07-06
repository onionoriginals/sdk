import { useMemo, useSyncExternalStore } from 'react';
import { hero } from '../content';
import { generateArtwork } from '../sdk/artwork';
import { getArtSeed, subscribeArtSeed } from '../sdk/artwork-sync';
import { InstallCommand } from './InstallCommand';
import { Pipeline } from './Pipeline';
import './hero.css';

export function Hero() {
  // The halo IS the demo's asset: same seed the demo will hash and inscribe,
  // fresh per visit, live-updated as the visitor edits it in the demo.
  const seed = useSyncExternalStore(subscribeArtSeed, getArtSeed);
  const art = useMemo(
    () => generateArtwork(seed.title, seed.medium, seed.nonce, { transparent: true }),
    [seed]
  );

  return (
    <section className="hero" id="top">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-art" aria-hidden="true">
        <img key={art.dataUri} src={art.dataUri} alt="" />
      </div>
      <div className="container">
        <p className="hero-eyebrow">{hero.eyebrow}</p>
        <h1 className="hero-headline">{hero.headline}</h1>
        <p className="hero-subhead">{hero.subhead}</p>
        <div className="hero-actions">
          <a className="btn btn-primary" href={hero.primaryCta.href}>
            {hero.primaryCta.label}
            <svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">
              <path
                d="M8 3v9m0 0 3.5-3.5M8 12 4.5 8.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <span className="hero-or">{hero.installHint}</span>
          <InstallCommand />
        </div>
        <figure className="hero-visual card">
          <Pipeline autoplay />
          <figcaption>{hero.pipelineCaption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
