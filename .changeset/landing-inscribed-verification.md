---
"@originals/landing": patch
---

Fix `/me/<did>` verification going red on every Original that was inscribed on Bitcoin.

`verifyOriginal` resolved the CEL through `resolveDidCel` with no `ordinalsProvider`. Inscribing appends a `migrate`/`btco` event carrying a `bitcoin-ordinals-2024` witness proof, which `verifyEventLog` fails closed on without one — so the check reported `CEL event chain did not verify` and the page showed "Verification incomplete", even though nothing was wrong with the chain. No provider can fix this in the browser: this origin proxies `/api/btc/sat|fee|broadcast`, not inscription lookups, so `HttpOrdinalsProvider.getInscriptionById` rejects by design.

The check now verifies the chain with `verifyEventLog` directly, and when the *only* failures are anchor lookups on events **after** the `did:webvh` migrate, it re-verifies the log up to that migrate — which is exactly the claim the page makes (genesis → this `did:webvh`) — and says how much it proved: `2 of 4 signed events verified → did:cel:… · the Bitcoin anchor needs an on-chain lookup this page can't make`. A tampered genesis, a bad signature, or an error on an earlier event still fails the check. A CEL whose migrate targets a different DID is now called out separately rather than being conflated with "could not be fetched".
