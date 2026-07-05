import { footer, site } from '../content';
import './footer.css';

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <a className="nav-wordmark" href="#top">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7.25" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
              <circle cx="10" cy="10" r="2" fill="currentColor" />
            </svg>
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
                    <a href={link.href} target="_blank" rel="noreferrer">
                      {link.label}
                    </a>
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
