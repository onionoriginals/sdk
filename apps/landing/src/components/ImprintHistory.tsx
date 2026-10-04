import { hero } from '../content';
import { Reveal } from './Reveal';

export function ImprintHistory() {
  const copy = hero.imprint;
  return (
    <>
      <div className="press-ribbon" aria-hidden="true">
        <div>{Array.from({ length: 4 }, () => copy.ribbon).join('　 /　 ')}</div>
      </div>
      <section className="press-history" aria-label={copy.historyLabel}>
        <div className="container">
          <div className="press-history-heading">
            <p>{copy.historyLabel}</p><p>{copy.historyNote}</p>
          </div>
          <Reveal className="press-history-track">
            <ol>
              {copy.history.map((event, i) => (
                <li key={event.title}>
                  <span className="press-history-number">0{i + 1}</span>
                  <div><h2>{event.title}</h2><p>{event.body}</p></div>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </section>
    </>
  );
}
