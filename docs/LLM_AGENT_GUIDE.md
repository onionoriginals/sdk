# Originals SDK 3 agent guide

For current public API signatures and examples, read
[the CEL 3 API guide](../packages/sdk/V3.md). For exact exported TypeScript
interfaces, use `@originals/sdk/types` and the built package declarations.
The root default `OriginalsSDK` provides local mutation, hosted publication,
Bitcoin preparation/submission, and fresh network recovery.

Read [CONTEXT.md](../CONTEXT.md) before describing controllers and holders;
read [CLAUDE.md](../CLAUDE.md) before modifying the implementation. Protocol
conformance follows the [selected profile](../specs/originals-cel-v3-profile.md)
and [authority contract](../specs/originals-cel-v3-authority.md).

Use `createAsset` with `{ id, mediaType, content }` resource inputs and explicit
`CelSigner` custody. Use `publishToWeb(asset, { domain })` with configured durable
storage, then the returned asset. Bitcoin writes use a persisted prepared
publication and explicit recovery; submission is not accepted chain state.
`resolveAssetFromWeb` and `resolveAssetFromSat` are the cold recovery APIs.

Standalone WebVH identity helpers remain supported and require an explicit
domain. They do not establish the asset's CEL publication. The older credential
utilities remain independent; asset publication does not automatically issue
migration credentials.

The [historical agent reference](history/previous-sdk/LLM_AGENT_GUIDE.md) applies
only when maintaining previous-format internal regression code. Its lifecycle
methods, envelopes, holder writes, and default-host examples are superseded.
