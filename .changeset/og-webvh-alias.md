---
"@originals/vh": minor
"@originals/sdk": minor
---

did:og: check a did:webvh alias for an existing Original from logs signed elsewhere (P3.6, P14.29).

`@originals/vh/og` adds `checkAliasUpdate`, `aliasCheckpoint` and `prepareAliasEntry`, and exports `gatherEvidence`. The check confirms four things: the signed entry extends the exact checkpoint, the existing author key signed it, it changes nothing but the alias list, and the alias's did:webvh log points back through `alsoKnownAs`. Anchored Originals are refused (P9.10). `@originals/sdk/og` adds `bundleEvidence`, `aliasSigningRequest`, `inspectBundle` and `checkBundleAlias`, plus `originals-og alias <inspect|unsigned|verify>`. None of these takes a key or signs anything, and a verified result is not a hosted alias.
