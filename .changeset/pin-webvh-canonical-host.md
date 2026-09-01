---
"@originals/landing": minor
---

**The did:webvh host is pinned to one canonical domain, not inherited from the visitor.**

`demoHost()` fell back to `window.location.host`, so whichever hostname a visitor arrived on was written into their DID — and a `did:webvh` domain cannot be changed after publication. Railway keeps its generated `*.up.railway.app` hostname reachable alongside a custom domain, so the wrong host was one bookmark away, permanently.

Three changes, all keyed on `VITE_WEBVH_HOST`:

- **Required on mainnet, named at boot.** `validateConfig` reports an unset or malformed `VITE_WEBVH_HOST` when `BTC_NETWORK=mainnet`, alongside the existing contract; a value carrying a scheme, port or path — or any uppercase — is rejected, since the DID embeds it verbatim and `URL` lowercases every host the server parses. Warn-only until `CONFIG_STRICT=1`, like every other rule.
- **A canonical-host redirect.** `buildFetch` takes a `canonicalHost` and 301s document requests arriving on any other host. `/api/*` is exempt: a 301 on a PUT is not safely replayable, and a platform probe must not chase a redirect to find a healthy process. Unset in dev and tests, where nothing redirects.
- **Documented as the permanent value it is**, with a pre-mainnet check that greps the built bundle rather than trusting the dashboard — Vite deletes the branch entirely when the var is absent at build time, so its presence in the chunk is the only evidence it was baked.
