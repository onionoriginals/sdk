import { buildFetch } from '../../../../apps/landing/server/app.ts';
import { resolve } from 'node:path';
import { createWebvhHostStore } from '../../../../apps/landing/server/webvh-host.ts';
const fetch = buildFetch({ apiRoutes: { 'GET /api/btc/network': () => Response.json({ network: 'off', faucetEnabled: false }) }, hostStore: createWebvhHostStore(), distDir: resolve(import.meta.dir, '../../../../apps/landing/dist') + '/' });
const server = Bun.serve({ hostname: '127.0.0.1', port: 3449, tls: { key: Bun.file('/tmp/landing-v3-qa.key'), cert: Bun.file('/tmp/landing-v3-qa.crt') }, fetch });
console.log(`QA server on ${server.url}`);
