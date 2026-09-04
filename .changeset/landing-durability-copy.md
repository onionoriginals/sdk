---
'@originals/landing': patch
---

**Landing: say what durable did:webvh hosting actually buys, instead of "hosted for keeps".**

Durability was settled at backups-only: one persistent volume plus a scheduled backup, no mirror and no off-box copy (#520). The publish step's `temporaryNote` told an anonymous visitor their log would be "hosted for keeps" once signed in, a promise a single volume with a scheduled backup cannot make. It now states the real horizon: an own path on a persistent volume, backed up on a schedule, kept for as long as this service runs.

The lifecycle timeline now states the did:btco distinction rather than implying it: once inscribed, the reveal metadata carries the whole signed log, so an inscribed Original's provenance survives even this service, while a log that stops at did:webvh lasts only as long as this service hosts it.
