---
"@originals/code": minor
---

Release Original (plan 049 §1.4, K15): the repo document names a release Original whose entries each record a release (tag, commit, branch entry, canonical result at the time) as a JSON manifest. New `originals-code release <tag>`; the verifier checks each release's commit is in the named branch chain. Anchoring it with the SDK's flow is exercised on disposable regtest (`bun run release:regtest`).
