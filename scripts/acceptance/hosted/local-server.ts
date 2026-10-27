/**
 * The `--target local` host (Bun): the landing's real hosting, submit and
 * account-index routes and durable store, on a temp data dir, on loopback.
 * Requests are answered under the Host they name, as on a deployed host.
 *
 * Env: ACCEPTANCE_DATA_DIR, ACCEPTANCE_JWT_SECRET, ACCEPTANCE_PORT_FILE.
 */
import { writeFileSync } from "node:fs";
import { verifyToken } from "@originals/auth/server";
import { createOriginalsStore, createOriginalsRoutes, createAnchoringLibrary, buildFetch, extractToken } from "@originals/host";

const dataDir = process.env.ACCEPTANCE_DATA_DIR;
const jwtSecret = process.env.ACCEPTANCE_JWT_SECRET;
const portFile = process.env.ACCEPTANCE_PORT_FILE;
if (!dataDir || !jwtSecret || !portFile) throw new Error("local-server needs ACCEPTANCE_DATA_DIR, ACCEPTANCE_JWT_SECRET and ACCEPTANCE_PORT_FILE");

const store = createOriginalsStore({ dataDir });
// main's account library (/me): GET /api/originals discovers hosted snapshots, and its evidence route restores them.
const originals = createOriginalsRoutes({
  // The landing's session check (apps/landing/server/originals-auth.ts): the JWT's subject.
  authenticate: (req) => {
    const token = extractToken(req);
    return token ? verifyToken(token, { secret: jwtSecret }).sub : null;
  },
  store,
  library: createAnchoringLibrary(dataDir, store),
});
const noHostStore = {
  async handlePut() {
    return new Response(null, { status: 501 });
  },
  read() {
    return new Response(null, { status: 404 });
  },
  serve() {
    return null as Response | null;
  },
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: buildFetch({
    apiRoutes: { "POST /api/originals": originals.record, "GET /api/originals": originals.list, "GET /api/originals/evidence": originals.evidence },
    hostStore: noHostStore,
    distDir: "/nonexistent/",
    originals,
    trustedProxyHops: 0,
    log: () => {},
  }),
});
writeFileSync(portFile, String(server.port));
