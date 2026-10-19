/**
 * Witnesses over HTTP (plan 011, PR 8a). PROVISIONAL protocol
 * `originals-witness/0.1`, at one endpoint URL:
 *
 *   GET  <endpoint>   200 { protocol, id }
 *   POST <endpoint>   JSON { original, log, witness }  ->  200 { proof }
 *                     or 4xx/5xx { error: { category, code, message } }
 *
 * A refusal keeps its spec section 6 category and code, so the SDK reports
 * why each witness refused. The handler takes and returns Fetch API objects,
 * so it runs under Bun.serve, Node or a worker. The client is browser-safe.
 */
import { OriginalsError, type ErrorCategory } from "@originals/vh";
import type { DataIntegrityProof } from "@originals/vh/crypto";
import { isJsonObject } from "@originals/vh/json";
import type { WitnessFileEntry } from "@originals/vh/log";
import type { WitnessClient, WitnessRequest } from "./witness.js";

export const WITNESS_PROTOCOL = "originals-witness/0.1";

const STATUS: Partial<Record<ErrorCategory, number>> = {
  "invalid-evidence": 422,
  "unauthorized-key": 403,
  deactivated: 403,
  fork: 409,
  "incomplete-evidence": 503,
  "unavailable-bytes": 503,
  "limit-exceeded": 413,
};

const CATEGORIES = new Set<string>([
  "invalid-evidence", "incomplete-evidence", "unsupported-profile", "unauthorized-key", "author-binding",
  "stale-parent", "fork", "deactivated", "unavailable-bytes", "limit-exceeded",
]);

function errorResponse(status: number, category: string, code: string, message: string): Response {
  return Response.json({ error: { category, code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export interface WitnessHandlerOptions {
  /** Requests above this size are refused before parsing. */
  maxBodyBytes?: number;
}

/** Serve one witness at one endpoint. */
export function witnessHandler(witness: WitnessClient, options: WitnessHandlerOptions = {}): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  return async (request) => {
    if (request.method === "GET") return Response.json({ protocol: WITNESS_PROTOCOL, id: witness.id });
    if (request.method !== "POST") return errorResponse(405, "invalid-evidence", "METHOD_NOT_ALLOWED", "GET or POST");
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return errorResponse(413, "limit-exceeded", "REQUEST_TOO_LARGE", `at most ${maxBodyBytes} bytes`);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > maxBodyBytes) return errorResponse(413, "limit-exceeded", "REQUEST_TOO_LARGE", `at most ${maxBodyBytes} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return errorResponse(400, "invalid-evidence", "REQUEST_INVALID", "the body is not JSON");
    }
    if (!isJsonObject(parsed) || typeof parsed.original !== "string" || typeof parsed.log !== "string" || !Array.isArray(parsed.witness)) {
      return errorResponse(400, "invalid-evidence", "REQUEST_INVALID", "the body is { original, log, witness }");
    }
    try {
      const proof = await witness.approve({ original: parsed.original, log: parsed.log, witness: parsed.witness as unknown as WitnessFileEntry[] });
      return Response.json({ proof }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof OriginalsError) return errorResponse(STATUS[error.category] ?? 422, error.category, error.code, error.message);
      return errorResponse(500, "unavailable-bytes", "WITNESS_FAILED", "the witness failed");
    }
  };
}

export interface HttpWitnessClientOptions {
  /** The witness's did:key, as the author DID declares it. */
  id: string;
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A `WitnessClient` that asks a witness over HTTP. */
export function httpWitnessClient(options: HttpWitnessClientOptions): WitnessClient {
  const { id, endpoint } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const unreachable = (message: string) => new OriginalsError("unavailable-bytes", "WITNESS_UNREACHABLE", `${endpoint}: ${message}`);
  return {
    id,
    async approve(request: WitnessRequest): Promise<DataIntegrityProof> {
      const doFetch = options.fetch ?? globalThis.fetch;
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw unreachable("no response");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unreachable(`answered ${response.status} without JSON`);
      }
      if (!response.ok) {
        const e = isJsonObject(body) && isJsonObject(body.error) ? body.error : {};
        const category = typeof e.category === "string" && CATEGORIES.has(e.category) ? (e.category as ErrorCategory) : "unavailable-bytes";
        throw new OriginalsError(category, typeof e.code === "string" ? e.code : "WITNESS_REFUSED", typeof e.message === "string" ? e.message : `answered ${response.status}`);
      }
      const proof = isJsonObject(body) ? body.proof : undefined;
      if (!isJsonObject(proof) || typeof proof.verificationMethod !== "string") throw unreachable("answered without a proof");
      // The proof is verified with the entry; here it must at least come from this witness's key.
      if (!proof.verificationMethod.startsWith(`${id}#`)) {
        throw new OriginalsError("invalid-evidence", "WITNESS_PROOF_MISMATCH", `${endpoint} answered with a proof by ${proof.verificationMethod}, not ${id}`);
      }
      return proof as unknown as DataIntegrityProof;
    },
  };
}
