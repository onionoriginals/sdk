---
'@originals/landing': patch
---

**Explore's public Bitcoin verification no longer reports a legitimately rotated Original as unverified (#782).**

`evaluateBtcoCheck` required the *current* on-sat controller to exactly equal the controller frozen in the hosted webvh CEL log at the `webvh → btco` migration boundary. Per CLAUDE.md, "Rotation retires the outgoing key; holding or reacquiring the sat does not restore its authority" — a controller rotation signed after anchoring to Bitcoin is normal, protocol-authorized state evolution, not evidence of a broken binding. Any Original that rotated its controller post-anchor failed this check identically to the "unrelated sat" case, giving a public visitor no way to tell a legitimate rotation from actual fraud.

The controller comparison is removed. The check now verifies `resolution.status === 'accepted'`, the asset identity binding (`sameAssetIdentity`, unchanged), and `state.active` — the same anti-substitution guard the surrounding code already relied on, since the resolver is independently pinned to the expected asset id.
