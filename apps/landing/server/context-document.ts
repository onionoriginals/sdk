/**
 * The JSON-LD context document, served at `/context`.
 *
 * Every credential the SDK issues references `https://originals.build/context`
 * (`packages/sdk/src/vc/Issuer.ts`, `CredentialManager.ts`), and until this
 * route existed that URL returned the SPA's `index.html` with
 * `content-type: text/html`. Our own stack never noticed, because
 * `packages/sdk/src/utils/serialization.ts` short-circuits the document loader
 * with a bundled copy — but a conformant verifier with a real document loader
 * has nothing to load, so every Originals credential is unprocessable outside
 * this repo. That is the whole interop surface, broken by a missing route.
 *
 * The bytes come from the SAME module the SDK bundles, imported across the
 * workspace rather than copied, so the hosted document cannot drift from the
 * one credentials are actually verified against. A copy here would be a second
 * source of truth for a document whose only job is to be the single one.
 *
 * Host-agnostic on purpose: `/context` answers on whatever origin this process
 * serves, which is how the four URLs in the wild — originals.build plus the
 * pichu/cleffa/magby network domains in `packages/sdk/src/types/network.ts` —
 * are all satisfied by one route. They resolve to identical documents by
 * design; see the network table for why the domains differ at all.
 */
import originalsContext from '../../../packages/sdk/src/contexts/originals.json' with { type: 'json' };

/**
 * The served representation. Pretty-printed for a document humans read as
 * often as machines do, and computed once at module load: it is a constant.
 */
const BODY = JSON.stringify(originalsContext, null, 2) + '\n';

/**
 * `application/ld+json` is the registered JSON-LD media type and the one a
 * conformant document loader looks for; `application/json` is merely tolerated,
 * and `text/html` (what this URL used to return) is refused outright.
 */
const CONTENT_TYPE = 'application/ld+json; charset=utf-8';

/**
 * Wide-open CORS, deliberately. A browser-based verifier fetches this
 * cross-origin from whatever page it runs on, so without
 * `access-control-allow-origin` the route is only fixed for servers — and a
 * public, immutable, credential-less document has nothing to protect. The
 * response carries no cookies and reads no request state.
 */
const HEADERS: Record<string, string> = {
  'content-type': CONTENT_TYPE,
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'accept',
  // An hour, not a year: contexts are append-mostly, but a wrong one cached
  // immutably at every verifier is unrecoverable without changing the URL.
  'cache-control': 'public, max-age=3600',
  // The content-type is load-bearing here (a loader dispatches on it), so stop
  // a sniffer from overriding it.
  'x-content-type-options': 'nosniff',
};

/** The exact path served. Also the tail of every context URL the SDK emits. */
export const CONTEXT_PATH = '/context';

/**
 * Serves the context document, or `null` when the request is not for it —
 * letting the caller fall through to the routes after it.
 *
 * `OPTIONS` is answered for the CORS preflight a loader may send when it
 * negotiates with an `accept` header.
 */
export function serveContextDocument(req: Request, url: URL): Response | null {
  if (url.pathname !== CONTEXT_PATH) return null;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...HEADERS, allow: 'GET, HEAD, OPTIONS' } });
  }
  return new Response(BODY, { headers: HEADERS });
}

/** The document itself, for tests that assert the served bytes match it. */
export const contextDocument: unknown = originalsContext;
