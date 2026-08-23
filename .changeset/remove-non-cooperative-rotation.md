---
"@originals/sdk": major
"@originals/cel": major
---

**BREAKING: the non-cooperative rotation path (#366) is removed.** Holding the anchoring sat grants no control of an asset's key set: a `rotateKey` whose controller proof is not authorized by the current key lineage now always fails verification, even when it carries a fully verified reinscription witness on the anchored sat. The sat proves ownership and (in an upcoming release) gates the right to append — it never buys the identity slot.

Removed APIs:

- `sdk.lifecycle.authorizeSigner(...)` (`@originals/sdk`) — the write side of the deleted path (a self-signed rotation plus reinscription witness). There is no replacement call: the cooperative `rotateBtcoKeys` (signed by the outgoing controller) is the only rotation. The capability the removal takes away — a buyer establishing their own authoring key without the seller's signature — returns in the sat-gated-appends release, where a sat holder appends with their own key directly, with no rotation and no key-set change.
- `EventVerification.nonCooperativeRotation` (`@originals/cel`) — rotations are only ever cooperative now, so the field is meaningless.

Documented consequence: **the controller key lineage is frozen once an asset is inscribed.** A creator who loses the post-migrate controller key can no longer rotate it away; pre-anchor rotation is unaffected.
