---
"@originals/sdk": major
---

`asset.verify()` uses the SDK-configured `ordinalsProvider` and returns a
`VerificationReport` instead of a bare boolean.

**Breaking.** `asset.verify()` and `sdk.lifecycle.verifyAsset()` now resolve to
`{ verified, code?, message?, details? }`. The report object is always truthy,
so `if (await asset.verify())` silently becomes always-true — update call sites
to check `.verified`.

Two fixes behind one change:

- Assets minted or loaded through `sdk.lifecycle` carry the configured
  `ordinalsProvider`, so the documented create → publish → inscribe → verify
  flow now ends `true`. It previously ended `false` for every inscribed asset
  unless the caller re-passed a provider the SDK already held.
- A failure now names a reason. In particular `ORDINALS_PROVIDER_REQUIRED`
  distinguishes "the Bitcoin witness proof was not checked" from "the proof does
  not hold" — a distinction a boolean could not express, and the one that
  matters most for a provenance product.

`checkGenesisResourceBinding` is now total: a resource whose hash is not sha256
hex is simply not a match, where it previously threw.
