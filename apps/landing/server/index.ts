import { json, route } from './router';

const PORT = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    return route(req, {
      'GET /api/health': () => json({ status: 'ok' }),
    });
  },
});

console.log(`[auth-server] listening on http://localhost:${server.port}`);
