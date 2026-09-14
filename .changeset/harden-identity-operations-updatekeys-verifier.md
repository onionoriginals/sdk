---
"@originals/sdk": patch
---

**`createDIDOriginal`/`updateDIDOriginal` now reject non-Ed25519 `updateKeys` and unguarded sign-only signers** (#714, #719).

`WebVHManager.assertEd25519WebVHUpdateKeys` already enforces that did:webvh `updateKeys` must be Ed25519, because this SDK's did:webvh log resolution is Ed25519-only — a DID minted with a non-Ed25519 updateKey signs successfully but can never resolve afterward. The standalone `identity-operations.ts` helpers (`createDIDOriginal`/`updateDIDOriginal`, also exported as static `OriginalsSDK.createDIDOriginal`/`updateDIDOriginal`) are a second, independent path into `didwebvh-ts` and did not share that guard. Both now normalize `updateKeys` (accepting legacy `did:key:...` input, as before) and then validate them as Ed25519 before any signing work, matching `WebVHManager.createDIDWebVH`.

Separately, both helpers' signer-as-verifier fallback (`verifier: options.verifier || options.signer`) had no `verify()` capability guard: a sign-only `ExternalSigner` (the documented public interface has no `verify()` member) was silently cast to a verifier, which made `didwebvh-ts` fail deep inside with a raw `TypeError: verifier.verify is not a function` instead of a clear error at this seam. Both helpers now only use the signer as its own verifier when it actually implements `verify()`, and otherwise throw a clear error asking for an explicit `verifier` — mirroring the guard `WebVHManager.createDIDWebVH` already applies.

An explicit, valid Ed25519 `updateKeys` and a signer/verifier pair supplied either way continue to work exactly as before.
