import { why } from '../content';
import { Reveal } from './Reveal';
import './why.css';

const icons = [
  // shield-check — verifiable
  <svg key="0" viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M10 2.2 4 4.6v4.2c0 4 2.6 6.9 6 8.4 3.4-1.5 6-4.4 6-8.4V4.6L10 2.2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="m7.2 9.9 2 2 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>,
  // layered arrow — lifecycle
  <svg key="1" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 13.5 10 17l7-3.5M3 10l7 3.5L17 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    <path d="M10 3v7.5m0 0 2.6-2.6M10 10.5 7.4 7.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>,
  // pillar — standards
  <svg key="2" viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M3.5 7.5 10 3l6.5 4.5M4.5 8v6M8.2 8v6M11.8 8v6M15.5 8v6M3 16.5h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
];

export function Why() {
  return (
    <section className="section" id={why.id}>
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{why.eyebrow}</p>
          <h2>{why.headline}</h2>
          <p>{why.subhead}</p>
        </Reveal>
        <div className="why-grid">
          {why.cards.map((card, i) => (
            <Reveal key={card.title} delay={i * 70}>
              <article className="card why-card">
                <span className="why-icon">{icons[i]}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
