---
"@originals/sdk": major
---

**BREAKING: `createDIDWebVH` and `migrateToDIDWebVH` now require an explicit `domain`.** Omitting or empty-passing it throws `WEBVH_DOMAIN_REQUIRED` instead of defaulting to `pichu.originals.build`.

The `*.originals.build` networks are never stood up and a did:webvh domain is permanent once published, so the SDK no longer guesses a host that would never answer. Pass a real domain (e.g. `example.com` or `localhost:3000`).
