---
'@originals/landing': patch
---

**Money path: `POST /api/btc/inscribe` now verifies where the value actually goes, not just where it's declared to go (#493 M07).**

The server-side re-check added for #493 validated transaction shape and destination — input set, output count, change/reveal script — but never how much value came in, so a signer with custody of the funding key could shrink or drop the commit's change output, or shrink the reveal's own output, and let the difference become miner fee undetected.

The route now independently re-derives the true value of every declared funding outpoint from the deposit indexer (never the client-declared `value`), and requires the commit's outputs plus a bounded fee to account for the full independently-verified input total. A commit that omits its change output must be justified by a genuine sub-dust surplus; anything larger is refused. The same fee bound now also applies to the reveal's own output, using its cryptographically-bound input value.
