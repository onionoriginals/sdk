import { createTspHttpHandler, type TspHttpHandlerOptions } from './server.js';
import { webvhTspInboxPathname } from '../vid/webvh-inbox.js';

export type TspInboxRoute = {
  /** did:webvh identifier served at this inbox path. */
  did: string;
  options: TspHttpHandlerOptions;
};

/**
 * Multi-DID TSP inbox router: maps each did:webvh's well-known inbox path to a handler.
 */
export function createTspInboxRouter(routes: TspInboxRoute[]): (req: Request) => Promise<Response> {
  const handlers = new Map<string, (req: Request) => Promise<Response>>();
  for (const route of routes) {
    const path = webvhTspInboxPathname(route.did);
    handlers.set(path, createTspHttpHandler(route.options));
  }
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/{2,}/g, '/');
    const handler = handlers.get(path);
    if (!handler) {
      return new Response(null, { status: 404 });
    }
    return handler(req);
  };
}