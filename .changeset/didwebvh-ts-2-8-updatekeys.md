---
"@originals/sdk": major
---

Update `didwebvh-ts` from 2.7.5 to 2.8.0 and adapt to its stricter did:webvh key-authorization format.

**BREAKING:** `did.jsonl` logs persisted by SDK versions built against didwebvh-ts ≤2.7.5 store `did:key:`-prefixed updateKeys inside signed log entries and will no longer verify/resolve under 2.8.0's stricter check (see FOLLOWUP.md item 11). The entries are signed, so they cannot be rewritten; affected DIDs must be re-created or verified with an older SDK.

Details: 2.8.0's `isKeyAuthorized` compares `updateKeys` entries against the bare multikey parsed from each proof's `did:key:` verification method (per the did:webvh spec), so every did:webvh create/update/rotate/recover path now passes bare multikeys (`z6Mk...`) as `updateKeys` and computes pre-rotation `nextKeyHashes` over the bare key. A new exported `normalizeUpdateKey()` helper strips the legacy `did:key:` prefix (and fragment) from caller-provided `updateKeys` in `WebVHManager.createDIDWebVH`, `DIDManager.createDIDWebVH`, `OriginalsSDK.createDIDOriginal`, and `OriginalsSDK.updateDIDOriginal`, so existing external-signer integrations keep working unchanged. Because pre-rotation `nextKeyHashes` commit to the exact updateKey string and cannot be normalized after hashing, combining legacy `did:key:`-form updateKeys with `nextKeyHashes` in the `OriginalsSDK` Original wrappers is now rejected with a descriptive error; compute hashes with the newly exported `computeNextKeyHash(<bare multikey>)`. `createDIDOriginal` also now forwards the previously-dropped `nextKeyHashes`, `portable`, `controller`, `alsoKnownAs`, `authentication`, `assertionMethod`, `keyAgreement`, and `services` options to didwebvh-ts.
