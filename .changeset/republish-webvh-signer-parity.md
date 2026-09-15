---
"@originals/sdk": patch
---

**`publishToWeb` no longer requires an Ed25519 `webvhSigner` to republish an already-hosted asset** (#703).

`HostedAssets.prepare()` validated that the WebVH method signer was Ed25519 before branching on whether the call was a first-time WebVH mint or a republish of an already-hosted (`state.layer === "webvh"`) asset. The republish branch fetches and returns the existing `did.jsonl` verbatim — it never signs the method log — so a controller who rotated their asset's signing key to P-256 or P-384 (a fully supported `CelSigner` algorithm) could no longer republish that asset (a new resource version, a metadata update, a further rotation) without also supplying an unrelated, functionally-unused Ed25519 key as `webvhSigner`.

The Ed25519 method-custody check now only runs in the "mint a new WebVH identity" branch, which is the only branch that actually uses `methodSigner` to sign the method log. Republishing with a correctly-authorized non-Ed25519 controller signer now succeeds exactly as it does for an Ed25519 controller; first-time WebVH publication still requires an explicit Ed25519 `webvhSigner` when the controller itself is not Ed25519.
