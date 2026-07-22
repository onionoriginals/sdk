/**
 * Minimal client-side routing — no react-router. Three views: the landing page
 * ('/'), Your Originals ('/me'), and a single Original's detail page
 * ('/me/<encoded did>'). navigate() pushes history and notifies subscribers;
 * useLocationPath() re-renders on navigate + browser back/forward.
 */
import { useEffect, useState } from 'react';

export type RouteName = 'landing' | 'your-originals' | 'original-detail';

export function routeForPath(pathname: string): RouteName {
  if (pathname === '/me') return 'your-originals';
  if (pathname.startsWith('/me/') && didFromPath(pathname)) return 'original-detail';
  return 'landing';
}

/** Path for a single Original's detail page. The DID is one encoded segment. */
export function originalPath(did: string): string {
  return `/me/${encodeURIComponent(did)}`;
}

/**
 * The DID encoded in an '/me/<did>' path, or null when the path isn't one
 * (including a malformed percent-encoding, which decodeURIComponent throws on).
 */
export function didFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/me/')) return null;
  const seg = pathname.slice('/me/'.length);
  if (!seg || seg.includes('/')) return null;
  try {
    const did = decodeURIComponent(seg);
    return did.startsWith('did:') ? did : null;
  } catch {
    return null;
  }
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
