# Getting started with Originals SDK 3

Install `@originals/sdk` using a Node version supported by its `engines` field.
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
