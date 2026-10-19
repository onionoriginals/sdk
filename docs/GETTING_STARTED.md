# Getting started with the Originals SDK

The SDK implements the Originals Protocol: each Original is a `did:vh` log
under the `originals:1.0` extension, signed by its author's DID. Start with
[the package README](../packages/sdk/README.md) for a short example, then read
[the consumer contract](../packages/sdk/ORIGINALS.md), which describes the
local workflow, verification reports and evidence packages, and says which
later phases (web publication, Bitcoin anchoring) are not implemented yet.

1. Create an author DID (did:webvh) with `createDIDOriginal`, or with
   `@originals/auth` for Turnkey custody. The author key you sign Originals with
   is an `assertionMethod` key that is not an update key of the author DID.
2. Create an Original with `OriginalsSDK.create({ store, authors })` and
   `sdk.create(...)`, signing with `keySigner` or your own `OriginalsSigner`.
3. Edit it against an explicit parent checkpoint, and exchange it as a ZIP
   evidence package with `sdk.package` and `sdk.load`.

The earlier CEL 3 SDK and its tutorials were deleted in plan 011 PR 5.
