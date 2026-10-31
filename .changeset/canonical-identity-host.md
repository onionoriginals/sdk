---
"@originals/sdk": major
"@originals/landing": minor
---

Remove retired identity hostnames and context aliases. SDK WebVH profile names
are now `development`, `staging`, and `production`; update `webvhNetwork` inputs
to those names. Every profile uses the canonical `originals.build` domain and
context; DID creation continues to require an explicit domain.

The landing defaults to `originals.build` and reads identities only from its
configured `VITE_WEBVH_HOST`. Accounts with an identity on another host must
explicitly create a new identity. Existing signed work is not migrated or
re-signed. The landing no longer serves an additional legacy identity host.
