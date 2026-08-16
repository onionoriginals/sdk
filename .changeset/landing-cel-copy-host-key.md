---
"@originals/landing": patch
---

Let the SDK's layer-agnostic CEL copy through the durable host-key guard, so `did:cel` resolves from storage for signed-in users.

`LifecycleManager.persistCelArtifacts` writes two copies after genesis and after every append: the webvh-hosted `<host>/<path>/cel.json`, and `cel/<did:cel digest>.json` — the conventional key `DIDManager.resolveDID`'s `did:cel` branch reads back. `isWebvhArtifactKey` only recognised `…/did.jsonl`, `…/cel.json` and `…/resources/<multibase>`, so the second key was rejected as `forbidden_path` (403), swallowed as a `cel:host-failed` warning. On the durable path that copy never landed and `did:cel` never resolved from storage. (The anonymous ephemeral host has no key guard, so only signed-in users were affected.)

The allowance is tight: exactly two segments, the first literally `cel`, the second `u<base64url>.json`. `serve()` keys on `${url.host}${url.pathname}`, so this key is only reachable as host `cel` plus `/<digest>.json` — it cannot name a path on the app's own origin, which is the static-asset shadowing the guard exists to prevent.
