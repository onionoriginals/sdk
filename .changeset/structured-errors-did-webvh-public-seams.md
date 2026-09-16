---
"@originals/sdk": patch
---

Fix `identity-operations.ts` and `WebVHManager.updateDIDWebVH`/`rotateDIDWebVHKeys` throwing plain `Error` instead of `StructuredError` on their public validation paths (#720, a sibling of #711).

`prepareDIDDataForSigning`, `verifyDIDSignature`, `createOriginal`, `createDIDOriginal`, `updateOriginal`, and `updateDIDOriginal` (all exported as static `OriginalsSDK`/`OriginalsSDK3` methods and consumed directly by `@originals/auth`'s Turnkey signer), plus `WebVHManager.updateDIDWebVH` and `WebVHManager.rotateDIDWebVHKeys`, now throw `StructuredError` with a stable `.code` on every validation-failure branch, matching the pattern already used elsewhere in the same files (e.g. `WEBVH_VERIFIER_REQUIRED`, `WEBVH_DOMAIN_REQUIRED`). Callers doing `catch (e) { if (e.code === ...) }` around these methods no longer silently get `undefined`.

New codes: `WEBVH_MODULE_LOAD_FAILED`, `ED25519_INVALID_KEY_LENGTH`, `ORIGINAL_TYPE_UNSUPPORTED`, `WEBVH_PREROTATION_KEY_FORMAT`, `WEBVH_UPDATE_DID_UNRESOLVED`, `WEBVH_PREROTATION_UNSUPPORTED`, `WEBVH_PREROTATION_REQUIRED`, `WEBVH_INVALID_RESULT_DOCUMENT`. Error messages are unchanged, so existing message-based assertions are unaffected. `WebVHManager.createDIDWebVH`'s raw-`Error` throws remain out of scope here — that method is #711's own scope (PR #786).
