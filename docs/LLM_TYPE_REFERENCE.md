# Originals SDK 3 type reference

The supported declarations are generated from the implementation and exported by
`@originals/sdk/types`. Root `OriginalsSDKOptions` and `OriginalsConfig` describe
the full CEL 3 SDK; `@originals/sdk/v3` has the smaller local-only configuration.

[The API guide](../packages/sdk/V3.md) explains `AssetResourceInput`,
`AssetEnvelope`, `MutationResult`, `AssetVerification`, prepared hosted and
Bitcoin publications, and recovery stores. The compiled consumer fixture is
[`packages/sdk/tests/types/public-cel3.ts`](../packages/sdk/tests/types/public-cel3.ts).

Use `@originals/sdk/cel` for the selected CEL 3 core types. The old manually
copied interfaces are retained only in the
[historical type reference](history/previous-sdk/LLM_TYPE_REFERENCE.md).
