---
"@originals/code": minor
---

Dogfood CI pieces (plan 049 §6, milestone 1). Remote identities (K21): a did:vh whose signing key is held in Turnkey; the identity file holds no secret, and `originals-code identity new-remote` creates one. `@originals/code/turnkey` signs entries through `@originals/auth`'s `turnkeySignBytes` and checks each signature before use; `workspace.mirror` takes a `sign` option for it. `originals-code rehydrate` (K22) rebuilds a workspace's objects from git, checked against its signed logs. `mirror --branch` writes into a named branch as an editor.
