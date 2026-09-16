---
"@originals/auth": patch
---

**`createDIDWithTurnkey` rejects an `updateKeyAccount` that isn't the canonical `did-update` Turnkey account, before any signing call** (#734).

`createDIDWithTurnkey` only ever read `updateKeyAccount.address`; `.curve` and `.path` were dropped on the floor, so a mislabeled or wrong-role Turnkey account (a `CURVE_SECP256K1` account, or an Ed25519 account at the `did-assertion` path instead of `did-update`) could be silently wired in as the did:webvh update key. Per `packages/sdk/V3.md`, method-log custody must be Ed25519, and the update key is a distinct role from the assertion key (#744).

`createDIDWithTurnkey` now validates `updateKeyAccount` against the canonical `did-update` role (`CURVE_ED25519` at its exact derivation path) and throws the new `TurnkeyUpdateKeyRoleError` otherwise, before constructing the signer or making any Turnkey signing call.
