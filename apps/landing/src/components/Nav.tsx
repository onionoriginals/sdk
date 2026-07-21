import { useEffect, useState } from 'react';
import { nav, site, yourOriginals } from '../content';
import { useAuth } from '../auth/useAuth';
import { navigate } from '../router';
import { LoginModal } from './LoginModal';
import './nav.css';

function Wordmark() {
  return (
    <a className="nav-wordmark" href="#top" aria-label={`${site.wordmark} — home`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.25" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        <circle cx="10" cy="10" r="2" fill="currentColor" />
      </svg>
      <span>{site.wordmark}</span>
    </a>
  );
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { isAuthenticated, user, signOut } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="nav" data-scrolled={scrolled || undefined}>
      <div className="container nav-inner">
        <Wordmark />
        <nav className="nav-links" aria-label="Primary">
          {nav.links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="nav-actions">
          <a className="nav-github" href={nav.github.href} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            <span>{nav.github.label}</span>
          </a>
          {isAuthenticated && (
            <a
              className="nav-your-originals"
              href="/me"
              onClick={(e) => {
                e.preventDefault();
                navigate('/me');
              }}
            >
              {yourOriginals.navLabel}
            </a>
          )}
          {isAuthenticated ? (
            <div className="nav-auth">
              <span className="nav-email" title={user!.email}>
                <span className="nav-email-dot" aria-hidden="true" />
                {user!.email}
              </span>
              <button className="nav-signout" onClick={() => signOut()}>Sign out</button>
            </div>
          ) : (
            <button className="btn btn-primary nav-cta" onClick={() => setLoginOpen(true)}>
              Sign in
            </button>
          )}
          <button
            type="button"
            className="nav-menu-btn"
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {open ? (
                <path d="m3 3 10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              ) : (
                <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav className="nav-mobile" aria-label="Mobile">
          {nav.links.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
          <a href={nav.github.href} target="_blank" rel="noreferrer">
            {nav.github.label}
          </a>
        </nav>
      )}
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </header>
  );
}
