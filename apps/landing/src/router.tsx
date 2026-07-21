/**
 * Minimal client-side routing — no react-router. Two views: the landing page
 * ('/') and Your Originals ('/me'). navigate() pushes history and notifies
 * subscribers; useLocationPath() re-renders on navigate + browser back/forward.
 */
import { useEffect, useState } from 'react';

export type RouteName = 'landing' | 'your-originals';

export function routeForPath(pathname: string): RouteName {
  return pathname === '/me' ? 'your-originals' : 'landing';
}

const NAV_EVENT = 'originals:navigate';

export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
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
