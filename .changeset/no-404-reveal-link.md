---
"@originals/landing": patch
---

**Stop linking a reveal transaction that has not been broadcast.**

An Original's detail page linked `revealTxId` to a block explorer unconditionally. The commit and reveal are both signed and persisted *before* either is broadcast, so that id exists long before the transaction does — and while a commit is still confirming, the link is a 404 handed to someone who has just paid.

Hit on a live mainnet run, moments after an inscription was submitted.

`inscriptionStatus` cannot answer this: it is written `'pending'` at inscribe time whichever transaction went out. The four-state broadcast status was already fetched client-side from `GET /api/btc/inscribe`, but `withLiveInscriptionStatus` used it only to upgrade rows to `'confirmed'` and discarded the rest. It now carries `revealBroadcast` through as well.

With that, the page links only what exists: the **reveal** once it is broadcast or confirmed, otherwise the **funding transaction**, which is genuinely on the network and is the thing worth watching. The reveal's id is still shown — with a line saying it is signed, saved, and goes out once the funding transaction confirms.
