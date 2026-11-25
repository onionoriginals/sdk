import {
  createTspInboxRouter,
  type TspInboxRoute,
} from '@originals/tsp';

const INBOX_ROOT = '/.well-known/tsp/inbox';
const INBOX_SUFFIX = '/tsp/inbox';

function isTspInboxPath(pathname: string): boolean {
  const path = pathname.replace(/\/{2,}/g, '/');
  return path === INBOX_ROOT || (path.endsWith(INBOX_SUFFIX) && path.length > INBOX_SUFFIX.length);
}

/**
 * Opt-in hosted TSP inbox: registers per-did:webvh routes and serves POST
 * `application/tsp+cesr` at the well-known inbox paths.
 */
export function createTspInboxHost() {
  let enabled = false;
  const routes: TspInboxRoute[] = [];
  let router: ((req: Request) => Promise<Response>) | null = null;

  const rebuild = (): void => {
    router = routes.length > 0 ? createTspInboxRouter(routes) : null;
  };

  return {
    get isEnabled(): boolean {
      return enabled;
    },
    setEnabled(value: boolean): void {
      enabled = value;
    },
    registerRoute(route: TspInboxRoute): void {
      routes.push(route);
      rebuild();
    },
    clearRoutes(): void {
      routes.length = 0;
      router = null;
    },
    async serve(req: Request, url: URL): Promise<Response | null> {
      if (!enabled || req.method !== 'POST' || !isTspInboxPath(url.pathname)) {
        return null;
      }
      if (!router) {
        return new Response(null, { status: 404 });
      }
      return router(req);
    },
  };
}

export type TspInboxHost = ReturnType<typeof createTspInboxHost>;