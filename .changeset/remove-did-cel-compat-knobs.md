---
"@originals/sdk": major
"@originals/cel": major
"@originals/landing": patch
---

Remove `deriveDid`, `AssetState.didCel` and the deprecated `expectedDid`
verification option from the CEL 2 / SDK 4 asset identity surface; use
`deriveAssetId`, `state.assetId`/`state.aliases` and `expectedAssetId` instead.
Rename `parseAssetDid` to `parseAssetAlias`, and its result's discriminator
from `method` to `layer` (`'cel' | 'webvh' | 'btco'`), since the `cel` layer
is not a claim that Originals implements a DID method. Old SDK 3 envelope
reading, signed history, hosted paths and inscriptions are unchanged.
