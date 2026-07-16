---
"@originals/sdk": patch
---

Harden CEL verifier ordering checks against provider-order fail-open (PR #395 review). The non-cooperative rotation check (d) and the head-freshness "newest anchor" selection now order inscriptions by per-inscription `blockHeight` (via `getInscriptionById`) instead of trusting `getInscriptionsBySatoshi`'s documented oldest-first list order, so a provider returning newest-first can no longer accept a pre-anchor inscription or mask a truncated log. Missing block heights fail closed; same-block ties fall back to list order. Behavior change: an UNCONFIRMED reinscription (whose `blockHeight` is null until it has ≥1 confirmation on OrdHttp/QuickNode) is now rejected by these ordering checks until it confirms — intended, fail-closed.
