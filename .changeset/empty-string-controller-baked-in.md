---
"@originals/sdk": patch
"@originals/auth": patch
"@originals/landing": patch
---

**`createDIDWithTurnkey` and `buildUserWebVHDid` no longer bake an empty-string `controller` into every verification method (#804).** Both called `OriginalsSDK.createDIDOriginal()` with `controller: ''` on each entry in `verificationMethods`, because the DID being minted isn't known until creation completes and the SDK's input type required `controller` up front. `didwebvh-ts` passes that value straight through instead of filling it in itself, so every verification method in the resulting DID document — and everywhere that document is published or resolved — carried a literal empty string instead of the DID.

- `CreateDIDOriginalOptions`/`UpdateDIDOriginalOptions` (`@originals/sdk`) now accept a `VerificationMethodInput` shape whose `controller` is optional. Omitting it lets `didwebvh-ts` derive the correct value; the returned `DIDDocument`'s `VerificationMethod.controller` is unaffected and remains required.
- `createDIDWithTurnkey` (`@originals/auth`) and `buildUserWebVHDid` (`@originals/landing`) now omit `controller` entirely instead of passing `''`.
