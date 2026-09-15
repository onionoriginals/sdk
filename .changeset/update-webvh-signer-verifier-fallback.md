---
"@originals/sdk": patch
---

**`WebVHManager.updateDIDWebVH` / `DIDManager.updateDIDWebVH` now fall back to the signer as verifier when no `verifier` option is supplied**, matching `createDIDWebVH`'s existing behavior (#702).

`packages/sdk/V3.md` documents that "Standalone WebVH signing accepts either a key pair or an external signer, with the appropriate verifier" — a signer that also implements `ExternalVerifier` (the pattern `TurnkeyWebVHSigner`/`TurnkeyDIDSigner` use) is a supported pattern. That pattern already worked on `createDIDWebVH`, but `updateDIDWebVH` passed `options.verifier` straight through with no fallback and threw `Verifier implementation is required` deep inside `didwebvh-ts` when it was omitted — forcing every caller to remember to pass a separate `verifier` on update even though `create` did not require one.

`updateDIDWebVH` now accepts the same dual signer/verifier object `createDIDWebVH` already accepts, and still requires an explicit `verifier` (with a clear error) when the supplied signer does not itself implement `verify()`.
