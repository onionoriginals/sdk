/**
 * R19 — the privacy and terms pages, at '/privacy' and '/terms'.
 *
 * One component for both: they are the same document shape (heading, subhead,
 * numbered sections of prose, one section with a list), and the copy is the
 * only difference. `legalRouteDoc` is the seam the route switch in App.tsx and
 * the tests both go through, so "does this route render this page" is a pure
 * question with no DOM involved.
 */
import { legal } from '../content';
import type { RouteName } from '../router';
import './legal.css';

export interface LegalSection {
  heading: string;
  body: string[];
  /** Rendered as a list between `body` and `footer` (the money-event roll-call). */
  list?: string[];
  /** Prose that follows the list. */
  footer?: string[];
}

export interface LegalDoc {
  navLabel: string;
  heading: string;
  subhead: string;
  sections: LegalSection[];
}

/** The document a route renders, or null when the route is not a legal one. */
export function legalRouteDoc(route: RouteName): LegalDoc | null {
  if (route === 'privacy') return legal.privacy;
  if (route === 'terms') return legal.terms;
  return null;
}

/**
 * Every string either page publishes, flattened. This is what the custody scan
 * and the disclosure checks read: a claim added to a new section is covered
 * without anyone remembering to widen the test.
 */
export function legalStrings(): string[] {
  const out: string[] = [];
  for (const doc of [legal.privacy, legal.terms] as LegalDoc[]) {
    out.push(doc.heading, doc.subhead);
    for (const section of doc.sections) {
      out.push(section.heading, ...section.body, ...(section.list ?? []), ...(section.footer ?? []));
    }
  }
  return out;
}

export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <main className="section legal">
      <div className="container legal-inner">
        <p className="eyebrow">{doc.navLabel}</p>
        <h1>{doc.heading}</h1>
        <p className="legal-sub">{doc.subhead}</p>
        <p className="legal-updated">
          {legal.updatedLabel} {legal.updated}
        </p>
        {doc.sections.map((section) => (
          <section key={section.heading} className="legal-section">
            <h2>{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.list && (
              <ul className="legal-list">
                {section.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {section.footer?.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
