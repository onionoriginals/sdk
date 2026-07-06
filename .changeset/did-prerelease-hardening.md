---
"@originals/sdk": patch
---

DID hardening: hash long did:peer suffixes on peer→webvh migration to avoid `ENAMETOOLONG`; fail closed (`unresolvable`) in the btco resolver when the newest inscription is unreadable instead of serving a stale document; pin btco `content_url` fetches to the configured origin and reject non-http(s) schemes/redirects (SSRF); enforce `keyPair`/`externalSigner` mutual exclusion and omit the empty `keyPair` placeholder when an external signer is used; throw instead of minting a keyless `did:btco` when a verification-method multikey cannot be decoded.
