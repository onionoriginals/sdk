---
"@originals/landing": patch
---

**Fix: OTP_LOGIN sent a DER signature where Turnkey verifies raw IEEE-P1363.**

Signing never worked on a real network build. Turnkey verifies OTP_LOGIN's
`clientSignature` over a raw (IEEE-P1363) P-256 signature — `@turnkey/core`
passes `SignatureFormat.Raw` explicitly — but every Turnkey stamper defaults to
DER, and the browser client called `sign(message)` with no format. Turnkey
rejected the signature, the session bootstrap threw, and the user was left
signed in but unable to inscribe.

Nothing local could catch it: both encodings are plain hex strings, so the
types, the build, and the test suite all passed. The suite's fake signer
returned `'deadbeef'`, which is neither shape.

The encoding is now pinned by `OTP_LOGIN_SIGNATURE_FORMAT` and passed
explicitly, and `otpLoginToSession` refuses a non-raw signature before the
network call, naming DER when it sees it — so a regression fails locally with
its cause in the message rather than as an opaque bootstrap failure in
production.
