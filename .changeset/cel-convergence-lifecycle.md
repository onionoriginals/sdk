---
"@originals/sdk": major
---

CEL convergence: the production asset lifecycle IS the event log. `createAsset` mints a `did:cel` genesis (dedicated Ed25519 controller key, signed CEL create event); every lifecycle operation appends a signed event (publish/inscribe → `migrate`, transfer → `transfer`, rotate → `rotateKey`); the inscribed DID document commits to the log head digest via an `OriginalsCelAnchor` service and doubles as the log's `bitcoin-ordinals-2024` witness proof; `asset.verify()` gates on whole-chain CEL verification plus fail-closed resource↔genesis digest binding. New exports: `celSignerFromKeyPair`, `createKeyStoreCelSigner`, `resolveDidCel`, `createCelDidDocument`, `replayProvenance`, `hexSha256ToDigestMultibase`.

BREAKING: `asset.id` from `createAsset` is now `did:cel:…` (was `did:peer:…`); `asset.verify()` on inscribed assets returns `false` unless `{ ordinalsProvider }` is passed (the bitcoin witness check is gating by design); `bindings['did:cel']` replaces `bindings['did:peer']`; `createAsset` requires real 64-char hex sha256 resource hashes.
