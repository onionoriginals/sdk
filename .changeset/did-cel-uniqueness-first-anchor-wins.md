---
"@originals/sdk": patch
---

did:cel uniqueness — first-anchor-wins. A btco-anchored did:cel log now verifies
only when its anchored sat is the canonical one (the sat of the log's earliest
on-chain anchoring, lowest confirmed block height grouped by sat), closing the
malicious-controller duping case where one did:cel is signed onto two sats. Adds
the `getAnchoringsForDidCel(didCel)` provider capability (implemented on
OrdMockProvider) and back-links the did:cel in the inscribed btco document's
alsoKnownAs so anchorings are enumerable. Fail-closed: a provider that cannot
enumerate or an anchoring missing a block height → UNIQUENESS_UNVERIFIABLE; a
same-block tie between different sats → AMBIGUOUS_CANONICAL; a non-canonical sat
→ NON_CANONICAL_ANCHOR. Follow-up to the signed-anchored-sat binding.

Compatibility note: because the check is part of the btco verification contract
(not opt-in), a btco-anchored did:cel log whose inscribed document predates this
release and therefore lacks the did:cel back-link in alsoKnownAs will now fail
UNIQUENESS_UNVERIFIABLE until re-anchored with the current writer shape.
