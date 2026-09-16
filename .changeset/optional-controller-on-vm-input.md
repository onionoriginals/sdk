---
"@originals/sdk": patch
"@originals/auth": patch
---

**`createDIDOriginal`/`updateDIDOriginal` accept a verification method with `controller` omitted; `createDIDWithTurnkey` no longer bakes `controller: ''` into its verification methods** (#804).

`createDIDWithTurnkey` (`packages/auth/src/client/turnkey-did-signer.ts`) constructed both of its verification methods with `controller: ''` because the SDK's `VerificationMethod` type required `controller: string` on input, even though didwebvh-ts fills a missing controller in with the DID being created (`vm.controller ?? did`). `??` does not replace an empty string, so the `''` survived verbatim into every DID document minted through the Turnkey auth path — a verification method that DID Core requires to be self-referential was left pointing nowhere.

Added `VerificationMethodInput` (`packages/sdk/src/types/did.ts`): the same shape as `VerificationMethod`, but with `controller` optional. `CreateDIDOriginalOptions.verificationMethods` and `UpdateDIDOriginalOptions.verificationMethods` now accept this input type; the returned `DIDDocument`'s `VerificationMethod.controller` is unaffected and remains required. `createDIDWithTurnkey` now omits `controller` entirely, letting didwebvh-ts's own fallback fill in the DID.
