export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export type Handler = (req: Request, url: URL) => Promise<Response> | Response;

export async function route(req: Request, routes: Record<string, Handler>): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return json({ error: 'Not found' }, 404);
  return handler(req, url);
}
