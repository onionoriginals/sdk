---
"@originals/landing": patch
---

**Fix: `/context` serves the JSON-LD context instead of the SPA.**

Every credential the SDK issues names `https://originals.build/context` in its `@context`. That URL returned `index.html` under `content-type: text/html`, so a conformant verifier's document loader had nothing to load and refused the credential. Any Originals credential was unprocessable outside this repo.

Our own stack never noticed, and could not have: `packages/sdk/src/utils/serialization.ts` short-circuits those URLs with a bundled copy and never makes the request. The break survived to production with every test green.

The route now answers with `application/ld+json`, ahead of the SPA fallback that used to catch it. Three details that matter:

- The bytes are imported from `packages/sdk/src/contexts/originals.json` — the same module the SDK verifies against — rather than copied, so the hosted document cannot drift from the one credentials are actually checked with.
- CORS is open. Without `access-control-allow-origin`, the route would be fixed for servers and still broken for any browser-based verifier.
- It is host-agnostic, so the pichu/cleffa/magby context URLs in `types/network.ts` are satisfied by the same handler.

Tests assert what a foreign loader checks: the media type, that the body parses as JSON-LD, CORS and its preflight, HEAD, and that the served document equals the SDK's copy read independently from disk.

`/vocab` is still the SPA. `@vocab` is an IRI prefix that loaders never dereference, so no credential depends on it.
