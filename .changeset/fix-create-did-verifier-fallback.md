---
"@originals/sdk": patch
---

**`createDIDOriginal` now falls back to the signer as verifier when no `verifier` option is supplied**, matching `updateDIDOriginal`'s existing behavior (#672).

`packages/sdk/V3.md` documents that "Standalone WebVH signing accepts either a key pair or an external signer, with the appropriate verifier" — a signer that also implements `ExternalVerifier` is a supported pattern. That pattern already worked on `updateDIDOriginal`, but `createDIDOriginal` passed `options.verifier` straight through with no fallback and threw `Verifier implementation is required` when it was omitted.
