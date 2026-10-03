---
"@originals/sdk": patch
---

**Breaking (folds into 4.0.0): `keyStore` is removed from the default `OriginalsSDK` options.** It was accepted and validated but no wired manager read it (`sdk.did`, `sdk.credentials`, `sdk.lifecycle` all ignored it), so a caller relying on it for custody minted assets it could not sign. `OriginalsSDK.create({ keyStore })` now throws `SDK_OPTION_REMOVED`; pass `{ signer }` (a `CelSigner`, e.g. `createLocalSigner`) for custody instead. The `KeyStore` type and `signerFromKeyStore` helper remain exported for the retained legacy lifecycle.
