---
"@originals/auth": patch
---

Reject non-string or malformed OTP codes and invalid supplied P-256 public keys locally before claiming a verification session or consuming its attempt budget. Preserve valid compressed and uncompressed hex keys, and generate a fallback key only when no key is supplied. Apply the same validation to the OTP encryption helper, with structured input errors that contain no OTP or key material.
