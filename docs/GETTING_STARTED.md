# Getting started with Originals SDK 4

This checkout documents the SDK 4 identity update; SDK 3.0.0 is already published.
Use a Node version supported by the chosen package's `engines` field. Existing
SDK 3 users should first read [the SDK 4 migration guide](MIGRATION_4.0.md).
An Original records signed file/version claims; `asset.id` is now the canonical
`ni` genesis commitment, separate from controller identity and publication aliases.
Follow the byte-based, explicit-custody example in
[the package README](../packages/sdk/README.md), then read
[the CEL 3 API guide](../packages/sdk/V3.md) before publishing.

1. Create a local asset from actual resource bytes and a `CelSigner`.
2. Configure durable storage and your explicit WebVH domain; publish and retain
   the returned asset. A fresh SDK can recover both signed histories and bytes.
3. For Bitcoin, configure a provider with complete sat snapshots, prepare the
   boundary or delta, persist the full prepared publication, and submit it with
   durable transaction recovery. Resolve the sat freshly to establish acceptance.

[The quick reference](LLM_QUICK_REFERENCE.md) lists current method names.
[The previous tutorial](history/previous-sdk/GETTING_STARTED.md) is historical;
its old lifecycle, resource inputs, and provider assumptions are superseded.
