import { hero } from '../content';
import { Flare } from './Flare';

/**
 * The history as an arc of the eclipse's limb, rising to the light: each event
 * is a point on it, and the latest one carries the flare. Dot heights follow
 * the arc (see .eclipse-record-line in eclipse.css); phones get a straight rule.
 */
export function RecordLine() {
  const { record } = hero;
  return (
    <section className="eclipse-record" aria-labelledby="record-heading">
      <div className="container">
        <div className="eclipse-record-head">
          <h2 id="record-heading">{record.headline}</h2>
          <p>{record.line} <span>{record.note}</span></p>
        </div>
        <div className="eclipse-record-body">
          <svg className="eclipse-record-arc" viewBox="0 0 1000 160" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 160 A1000 160 0 0 1 1000 0" vectorEffect="non-scaling-stroke" />
          </svg>
          <ol className="eclipse-record-line">
            {record.events.map((event, i) => (
              <li key={event.title}>
                {i === record.events.length - 1 && (
                  <Flare className="eclipse-flare" />
                )}
                <h3>{event.title}</h3>
                <p>{event.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
