---
"@originals/landing": patch
---

**Fix: authenticate the signing bootstrap with Turnkey's attested stamp.**

Signing failed on every real-network sign-in with:

```
Turnkey error 16: could not find public key in organization or its parent
organization ... PUBLIC_KEY_NOT_FOUND
```

thrown at the request stamp, not the body. The bootstrap called the `otp_login`
activity stamped with the browser's session key — a credential Turnkey has
never seen, because logging in is what installs it. The request could not
authenticate by construction.

Turnkey's own SDK does not use that activity here. For a credential-less
sub-org it configures an *attested* stamper from the verification token and
calls `stamp_login`. The verification token is Turnkey's own signed artifact
from verify-otp, so it authenticates a request from an org that holds no
credential yet — which is precisely the moment this runs.

The bootstrap now does the same: `X-Stamp-Attested` carrying the token, the
bound public key, and a DER signature over the exact request body, exchanged at
`/public/v1/submit/stamp_login`. Reproduced from `@turnkey/core` rather than
depended on, since that package pulls ethers, viem and WalletConnect into a
landing bundle.
