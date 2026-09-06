---
"@originals/sdk": major
"@originals/landing": patch
---

Make CEL 3 the default SDK asset API, with serialized mutations, byte-bound resource
versions, explicit draft recovery, matching public types, and a local-only CLI.
Remove previous asset writers/verifiers from the SDK entry points and preserve
standalone identity utilities. Keep the landing's preceding journey behind a
private application adapter until its CEL 3 network integration is complete.
