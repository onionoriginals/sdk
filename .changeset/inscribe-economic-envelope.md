---
"@originals/landing": patch
---

**`POST /api/btc/inscribe` now independently verifies fee/change economics, not just scripts and outpoints (#493 M07).**

The route already re-checked the SDK's own commit/reveal invariants (exact funding set and order, output count, change and reveal destinations, a valid inscription-reveal signature), but never bounded how much of the funding actually stayed with the creator. A signer that preserved every one of those checks could still omit or shrink the commit's change output and let the difference land in the miner fee.

The route now reads each declared funding outpoint's real value from the same indexer seam the deposit/prevtx routes already trust — never the client-declared `value` field — and compares the signed pair's actual, measured fee (from the finalized transactions' own byte sizes) against an envelope derived from the current fee policy. A pair that spends more than its funding set holds, or pays far more fee than current policy allows, is refused before broadcast.
