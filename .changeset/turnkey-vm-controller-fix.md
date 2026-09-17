---
"@originals/auth": patch
"@originals/cel": patch
"@originals/sdk": patch
---

**`createDIDWithTurnkey` no longer bakes an empty-string `controller` into Turnkey-created DID verification methods (#804).**

`createDIDWithTurnkey` constructed both verification methods it hands to `OriginalsSDK.createDIDOriginal` with `controller: ''` instead of omitting the field. `didwebvh-ts`'s own `vm.controller ?? did` fallback only replaces `null`/`undefined`, not an empty string, so the explicit `''` survived verbatim into every DID document minted through the Turnkey auth path — breaking any relying-party check that validates `vm.controller === doc.id`.

`createDIDWithTurnkey` now omits `controller` entirely, letting `didwebvh-ts` derive it as the document's own DID. `OriginalsSDK.createDIDOriginal`/`updateDIDOriginal`'s `verificationMethods` option now accepts the new `VerificationMethodInput` type (`controller` optional); the resolved `DIDDocument`'s `VerificationMethod.controller` is unchanged and still required.
