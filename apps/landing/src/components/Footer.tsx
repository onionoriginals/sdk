import { footer, site, hero } from '../content';
import { navigate, goToSection } from '../router';
import { Mark } from './Mark';
import { KeepLastWord } from './KeepLastWord';
import './footer.css';

/**
 * A root-relative href is one of this app's own routes (R19 added the first
 * two: '/privacy' and '/terms'). Those must be routed in-app rather than opened
 * in a new tab, which is what every other footer link does.
 */
export function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

export function Footer({ closing = false }: { closing?: boolean }) {
  return (
    <footer className="footer">
      {closing && (
        <div className="container footer-close">
          <p className="footer-closing"><KeepLastWord text={hero.closing} /></p>
          <a
            className="btn btn-primary btn-mark"
            href={hero.primaryCta.href}
            onClick={(e) => { e.preventDefault(); goToSection(hero.primaryCta.href); }}
          >
            <span className="btn-ring" aria-hidden="true" />
            {hero.primaryCta.label}
          </a>
        </div>
      )}
      <div className="container footer-inner">
        <div className="footer-brand">
          <a className="nav-wordmark" href="#top">
            <Mark />
            <span>{site.wordmark}</span>
          </a>
          <p className="footer-tagline">{footer.tagline}</p>
          <p className="footer-license">{footer.license}</p>
        </div>
        <div className="footer-columns">
          {footer.columns.map((column) => (
            <div key={column.title} className="footer-column">
              <h4>{column.title}</h4>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href}>
                    {isInternalHref(link.href) ? (
                      <a
                        href={link.href}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(link.href);
                          // The footer is the bottom of a long page; without
                          // this the new (short) page opens mid-scroll.
                          window.scrollTo({ top: 0 });
                        }}
                      >
                        {link.label}
                      </a>
                    ) : (
                      <a href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <span>{footer.bottomLeft}</span>
          <code>{footer.bottomRight}</code>
        </div>
      </div>
    </footer>
  );
}
