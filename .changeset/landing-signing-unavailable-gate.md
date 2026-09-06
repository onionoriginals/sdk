---
"@originals/landing": patch
---

**Fix: a failed signing bootstrap no longer tells the user to sign in again.**

A signed-in browser with no signing client fell through to one message — "sign
in again to get one" — whether it had never minted a key or had just tried and
failed. In the second case that instruction is unactionable: signing in is
exactly what failed, so following it loops.

`SigningStatus` gains `'unavailable'`, set by both catch paths that mean "we
tried and could not" (restore-on-reload and the post-OTP bootstrap). It renders
its own message — signing is down on our end, re-authenticating will not fix
it, the Original and any deposited BTC are untouched — and deliberately offers
no re-auth button, since offering the action that just failed is the defect.

`'none'` and `'expired'` are unchanged: there, signing in again is the remedy.
