---
"@originals/sdk": minor
---

Bind btco asset identity to the controller-**signed** anchoring satoshi. The migrate-to-btco CEL event now signs `data.to = did:btco:<network>:<sat>` (upgraded from a bare `'did:btco'`), and `verifyEventLog` derives the anchored sat from that signed body instead of the unsigned Bitcoin witness proof array. This closes two keyless-verifier soundness residuals: the **cross-sat fork** (repointing the witness to an attacker-controlled sat) and **witness-stripping** (dropping the witness so the log reads as never-anchored).

- **Breaking (verifier behavior):** a btco-anchored log whose migrate event does not sign a parseable sat now fails with `UNBOUND_ANCHOR`. A Bitcoin witness proof whose satoshi disagrees with the signed `data.to` is rejected. A signed btco migrate with no verifiable witness on the signed sat fails closed. This is a **hard cutover** — logs built with the old bare-`did:btco` migrate shape must be regenerated (nothing is released; only test logs existed).
- **Removed:** the ">1 witness poisons the anchor" ambiguity rule and the `STALE_LOG`-for-poisoned-anchor path — the signed `to` now disambiguates the canonical sat, so extra witnesses on other sats are simply invalid.
- Provenance fold (`replayProvenance`) and envelope restore now read the btco binding from the signed `data.to`, not the witness satoshi.

Unchanged: `did:cel` derivation, forward resolution, and the ownership-is-the-sat model (ownership is live sat control via `getCurrentOwner`). The `did:cel` uniqueness / first-anchor-wins work and the DID-document `alsoKnownAs` `did:cel` back-link are a separate follow-up spec, not included here.

Known follow-up (#397): the secondary `BtcoCelManager.migrate` / `cel migrate` btco path does not yet sign the anchoring sat and currently produces logs that fail `UNBOUND_ANCHOR`; it must land before a release is cut. The production `LifecycleManager.inscribeOnBitcoin` path is fully updated.
