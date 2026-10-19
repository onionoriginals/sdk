---
'@originals/sdk': major
'@originals/auth': patch
---

Delete the CEL 3 asset implementation and every earlier format (plan 011, PR 5). `@originals/cel` is removed from the repository, along with the SDK's `./cel`, `./v3` and `./asset-envelope` subpaths, the `originals-cel` CLI, `LifecycleManager`, `OriginalsAsset`, the migration subsystem and did:cel resolution. The root `OriginalsSDK` is now the Originals Protocol workflow from `@originals/sdk/originals`, and the did:webvh identity operations (`createDIDOriginal`, `updateDIDOriginal`, `verifyDIDSignature`, `prepareDIDDataForSigning`, `createOriginal`, `updateOriginal`) are exported as plain functions. The DID, credential, storage, Bitcoin, provider and crypto utilities stay, with their shared helpers (`StructuredError` from `@originals/vh`, Multikey, encoding, CBOR, satoshi validation, telemetry, `SatSnapshot` and the Bitcoin Core validators) now owned by the SDK. The byte-signer interface is exported as `ByteSigner`. `@originals/auth` calls the identity functions directly; its API is unchanged.
