/**
 * Minimal client-side routing for the landing, public Explore gallery/detail,
 * account gallery/detail, and legal pages.
 * navigate() pushes history and notifies subscribers; useLocationPath()
 * re-renders on navigate + browser back/forward.
 *
 * There is no not-found state, by design: anything unrecognised is the landing
 * page, so a mistyped URL lands somewhere useful rather than on an error.
 */
import { useEffect, useState } from 'react';

// Private /me recovery is available independently of the public Explore and
// publication gates. Unknown paths still return to the landing page.
export type RouteName = 'landing' | 'privacy' | 'terms' | 'originals';

export function routeForPath(pathname: string): RouteName {
  if (pathname === '/me' || pathname.startsWith('/me/')) return 'originals';
  if (pathname === '/privacy') return 'privacy';
  if (pathname === '/terms') return 'terms';
  return 'landing';
}

const NAV_EVENT = 'originals:navigate';

export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Navigate to a landing-page section by hash (e.g. '#why'). The nav is shown on
 * every route, but its section anchors are dead off '/' (on '/me' those sections
 * aren't mounted, so a plain `<a href="#why">` has no target). This routes home
 * first when needed, then smooth-scrolls once the section mounts.
 */
export function goToSection(hash: string): void {
  if (typeof window === 'undefined') return;
  const scrollWhenReady = (tries = 30): void => {
    const el = hash ? document.querySelector(hash) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (tries > 0) requestAnimationFrame(() => scrollWhenReady(tries - 1));
  };
  if (window.location.pathname !== '/') {
    navigate('/'); // remount the landing, then scroll
    if (hash) window.history.replaceState({}, '', hash);
    scrollWhenReady();
  } else {
    if (hash) window.history.replaceState({}, '', hash);
    scrollWhenReady();
  }
}

export function useLocationPath(): string {
  const [path, setPath] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(NAV_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAV_EVENT, update);
    };
  }, []);
  return path;
}
