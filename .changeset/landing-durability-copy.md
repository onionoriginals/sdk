---
'@originals/landing': patch
---

**Landing: say what durable did:webvh hosting actually buys, instead of "hosted for keeps".**

Durability was settled at backups-only (#520). The publish step's `temporaryNote` told an anonymous visitor their log would be "hosted for keeps" once signed in, a promise the deploy cannot make. It now states only what the deploy delivers today: an own path on a persistent volume, kept for as long as this service runs. The scheduled backup is recorded in `apps/landing/DEPLOY.md` as a pre-mainnet item that is not yet enabled, so the copy does not claim it.

The lifecycle timeline now states the did:btco distinction rather than implying it: once inscribed, the reveal metadata carries the whole signed log, so an inscribed Original's provenance survives even this service, while a log that stops at did:webvh lasts only as long as this service hosts it.
