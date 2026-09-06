export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// `clientIp` is the rate-limit identity the server layer already resolved
// (client-ip.ts). Handlers must key their limiters on THIS, never on a header
// they read themselves — see client-ip.ts for why. Optional so a handler can
// still be called directly in a test; absent, it degrades to one shared bucket.
export type Handler = (
  req: Request,
  url: URL,
  clientIp?: string
) => Promise<Response> | Response;

export async function route(
  req: Request,
  routes: Record<string, Handler>,
  clientIp?: string
): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return json({ error: 'Not found' }, 404);
  return handler(req, url, clientIp);
}
