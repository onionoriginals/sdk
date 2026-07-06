---
"@originals/auth": patch
---

Repo-level infra hygiene from the batch of 11 localized bug/security/infra fixes (#294): remove a committed TLS private key and ignore `*.pem`/`*.key`; `test:ci` uses `pipefail` so failing tests aren't masked by coverage; prune dead dependencies. No `@originals/auth` source changes — republished so the package reflects the cleaned-up repo. (The SDK-side fixes from this batch are recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
