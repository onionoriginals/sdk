/**
 * The witness service's routes. The witness logic is `OriginalsWitness` from
 * `@originals/sdk/originals`; this app only routes requests to it.
 *
 *   GET  /health      200 { ok: true, id }
 *   GET  <path>       200 { protocol, id }
 *   POST <path>       an approval request (originals-witness/0.1)
 */
import { OriginalsWitness, witnessHandler, type AuthorStateSource, type WitnessLedger } from "@originals/sdk/originals";

export interface WitnessAppOptions {
  secretKey: Uint8Array;
  path: string;
  ledger: WitnessLedger;
  authors: AuthorStateSource;
  clock?: () => number;
}

export function createWitnessApp(options: WitnessAppOptions): { id: string; fetch: (request: Request) => Promise<Response> } {
  const witness = OriginalsWitness.create({
    secretKey: options.secretKey,
    authors: options.authors,
    ledger: options.ledger,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const handle = witnessHandler(witness);
  return {
    id: witness.id,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/health" && request.method === "GET") return Promise.resolve(Response.json({ ok: true, id: witness.id }));
      if (pathname === options.path) return handle(request);
      return Promise.resolve(Response.json({ error: { category: "invalid-evidence", code: "NOT_FOUND", message: "not found" } }, { status: 404 }));
    },
  };
}
