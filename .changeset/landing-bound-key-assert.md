---
'@originals/landing': patch
---

**Fix: refuse a verification token bound to a key this browser does not hold (#494).**

The signing bootstrap took the `public_key` claim out of the verification token relayed by our own server and used it verbatim as the STAMP_LOGIN `publicKey` and the attested stamp's `publicKey`, never comparing it with the public half of the non-extractable key this browser actually holds. A dishonest relay could therefore have its own key installed as the 12-hour session credential on the victim's sub-org, and the victim would have seen only the generic "signing is unavailable" copy.

`stampLoginToSession` now throws `BoundKeyMismatchError` before anything is signed or sent when the token's bound key differs from the browser's, and the browser's own key is always the session public key. The auth provider maps that one error to its own notice, shown in the existing unavailable panel in place of the generic body, so the person is told the refusal was deliberate and asked not to send BTC.
