import { protocol } from '../content';
import { Reveal } from './Reveal';
import './protocol.css';

export function Protocol() {
  return (
    <section className="section" id={protocol.id}>
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{protocol.eyebrow}</p>
          <h2>{protocol.headline}</h2>
          <p>{protocol.subhead}</p>
        </Reveal>
        <div className="protocol-grid">
          {protocol.columns.map((column, i) => (
            <Reveal key={column.layer} delay={i * 70}>
              <article className="card protocol-card" data-layer={column.layer}>
                <header className="protocol-card-head">
                  <span className="protocol-stage">{column.stage}</span>
                  <div className="protocol-name-row">
                    <h3>{column.layer}</h3>
                    <span className="protocol-cost">{column.cost}</span>
                  </div>
                </header>
                <dl>
                  {column.rows.map(([term, value]) => (
                    <div key={term}>
                      <dt>{term}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                {i < protocol.columns.length - 1 && (
                  <span className="protocol-arrow" aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </article>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p className="protocol-note">
            <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
              <path d="M8 1.8 1.8 13.4h12.4L8 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M8 6.4v3.4m0 1.9v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            {protocol.migrationNote}
          </p>
        </Reveal>
      </div>
    </section>
  );
}
