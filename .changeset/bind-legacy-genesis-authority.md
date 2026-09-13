---
"@originals/cel": major
"@originals/sdk": major
---

**BREAKING (security): legacy `data.did` genesis events now bind authority to the create-event signer.** `verifyEventLog`'s legacy compatibility path — a genesis event that embeds the asset DID directly in `data.did`, rather than deriving it from `data.controller` — trusted the create event's signer on first use whenever `data.did` named a non-self-certifying DID (`did:webvh`, `did:web`, an old-scheme `did:cel` string, ...). Because `expectedDid` matching on that path is plain string equality against the embedded `data.did`, a forger could copy any victim's `data.did` into a freshly self-signed genesis and produce a log that "backs" the victim's identifier under the attacker's own key.

Legacy `data.did` now binds exactly like `data.controller` already does: a self-certifying `data.did` (`did:key`) requires the create event's signing key to be embedded in it; a non-self-certifying `data.did` requires the create proof's `verificationMethod` to name that exact DID, with the configured resolver vouching for the signing key. There is no trust-on-first-use fallback left on this path. A genesis that carries both a legacy `data.did` and a `data.controller` is now rejected outright as an ambiguous shape.

**Pre-existing legacy logs whose genesis names a non-self-certifying `data.did` that the create-event key does not (and cannot, via a resolver) authenticate no longer verify.** Logs whose `data.did` is self-certifying (`did:key`), or whose create proof's `verificationMethod` genuinely names the declared `data.did` under a working resolver, are unaffected. `DIDManager.resolveDID`/`resolveDidCel` inherit the fix — they delegate to `verifyEventLog`.
