---
"@originals/landing": patch
---

**Fix: a commit-only broadcast is no longer reported as an inscription.**

On the first real mainnet inscription the site said "inscribed" and offered an
explorer link to a reveal txid that returned 404.

The server had answered `status: 'commit_broadcast'` — the commit was on the
network, the reveal had not propagated, and the recovery sweep still owed the
creator an inscription. The server distinguishes the two outcomes and the
provider types them, but the SDK discards `submitInscription`'s return value,
so nothing downstream could tell them apart and every 200 rendered as done.

The provider now records what the submit achieved and the demo says it plainly:
the commit is on the network, the reveal follows automatically once it
confirms, nothing is stuck and nothing more is owed.
