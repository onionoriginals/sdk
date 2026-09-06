---
"@originals/sdk": major
"@originals/cel": minor
"@originals/landing": patch
---

Preserve resource bytes throughout the SDK and add the CEL 3 core and a real local regtest journey.

**SDK migration:** runtime resource content is now `Uint8Array`; creation inputs still accept text and encode it once as UTF-8. Decode returned text explicitly with `TextDecoder`, and call `asset.serialize()` before JSON serialization. AssetEnvelope version 2 encodes inline content as canonical base64; the loader still reads version-1 UTF-8 envelopes and emits version 2 on serialization. Hashes, sizes, publication and inscription use the original bytes. The SDK also exports an explicit loopback-only `RegtestProvider` and resolves btco asset and DID reads through the verified asset path.

**CEL core:** add `@originals/cel/v3` and the root `celV3` namespace for the selected CCG application profile, with strict JSON/CBOR encoding, Data Integrity signatures, one controller-history verifier and an on-sat snapshot fold. Existing package-root APIs remain available. The SDK mutation APIs, WebVH publisher, Bitcoin writer and live regtest journey still use the preceding CEL representation; migrating those callers is separate work.

**Landing:** preserve uploaded bytes through hosting and inscription, and persist signed commit/reveal pairs before broadcast so retries can recover from rejected reveals, lost commit responses and early reorganizations. Retire recovery records after six confirmations; this is an operational retention policy, not a finality guarantee. Add a disposable local regtest journey covering those recovery paths.
