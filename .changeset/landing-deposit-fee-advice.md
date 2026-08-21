---
"@originals/landing": patch
---

**Tell creators when their deposit is underpriced — and typecheck the server.**

A deposit paying below the going rate sits in the mempool with nothing on
screen to say why. Working that out meant opening a block explorer.

The deposit screen now shows the pending payment's fee rate against what the
network is clearing, and what to do about it. It is deliberately **not** a
button: replace-by-fee re-signs the original inputs, and those belong to
whatever wallet the creator paid from — not their Turnkey wallet — so the app
cannot replace that transaction. Only the sending wallet can. Offering an
action we cannot perform is the same defect as telling someone to sign in again
when signing in is what failed.

Where it can help is the arithmetic. BIP-125 requires a replacement to pay for
its own bandwidth on top of the original fee, so the floor is
`originalFee + vsize` — roughly triple a 1 sat/vB fee — and a small nudge is
rejected outright. The suggested rate clears both that floor and the network
rate, and the copy says to take the increase from change rather than from the
deposit amount.

Also adds `server/` to the landing typecheck. It was excluded, so the entire
money path — every route that moves a stranger's BTC — was unchecked. Adding it
required only Bun's types; there were no existing errors. It immediately caught
a call to an undefined function in this very change.
