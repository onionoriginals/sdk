---
"@originals/sdk": patch
---

**`@originals/sdk`'s main entry no longer crashes on import in a runtime without a global `Buffer`** (#838).

`packages/sdk/src/utils/serialization.ts`'s `canonicalizeDocument` statically imported `jsonld`, which pulls in `undici` via `jsonld`'s Node platform document loader; `undici` references the bare `Buffer` global at module-evaluation time. Because `canonicalizeDocument` is reachable eagerly from the package's main entry (`index.ts` exports `CredentialManager`, which imports `canonicalizeDocument` directly), simply running `import '@originals/sdk'` threw `ReferenceError: Buffer is not defined` in any runtime without a global `Buffer` (browsers, Cloudflare Workers/edge runtimes, Deno without Node compat), before any API was called. `jsonld` is now loaded with a dynamic `import()` inside `canonicalizeDocument`, matching the lazy-loading pattern already used elsewhere in this package (`crypto/signingInput.ts`), so importing the SDK no longer requires a global `Buffer` at all — only actually canonicalizing a credential does.

`scripts/check-browser-safety.mjs` now also verifies every guarded entry point (including `@originals/auth`'s `client/index.js`, which shared the same root chain through its dependency on `@originals/sdk`) by actually importing it in a subprocess with `globalThis.Buffer` deleted, instead of relying only on a static source-text scan — closing the regression-protection gap this bug exposed.
