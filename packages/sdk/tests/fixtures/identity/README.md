# Published SDK 3 compatibility fixture

`sdk3-web-publication.json` was generated on 2026-09-07 with the published npm
`@originals/sdk@3.0.0`, installed in a separate temporary directory. It was
prepared offline with an Ed25519 test signer (32 bytes of decimal 21), the name
`SDK 3 compatibility fixture`, and one resource `legacy.bin` with media type
`application/octet-stream` and exact bytes `[0, 255, 128, 7]`.

`prepareWebPublication(asset, { domain: 'example.com' })` produced the original
version-3 envelope, signed CEL migration from `did:cel`, and separately signed
WebVH log with that legacy backlink. No publication occurred. The artifact
contains public signatures and bytes only; the seed is public test material.
The test must consume the fixture unchanged, not regenerate it with SDK 4.

`sdk3-bitcoin-publication.json` extends that same old hosted fixture using the
published SDK 3 writer and test Bitcoin key (32 bytes of decimal 1). Its declared
regtest funding outpoint is synthetic (`12` repeated 32 times, output 0,
100,000 sats), selected sat `1250000000`, and fee rate 2. The offline fixture
provider declares a complete empty sat snapshot at height 100/hash `bb…bb`.
It contains actual signed transaction bytes but is not chain evidence and must
never be broadcast to a real provider. Its regression uses a recording provider
only to prove old saved transactions pass the new parser unchanged and can be
retried without signing or rebuilding.
