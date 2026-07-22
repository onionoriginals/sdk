---
"@originals/sdk": patch
---

Fix a deny-only front-running weakness in did:cel first-anchor-wins uniqueness (#402). `verifyUniqueness` counted **any** inscription that back-linked the did:cel via `alsoKnownAs`, so a non-controller could inscribe `{alsoKnownAs:["did:cel:Z"]}` on their own earlier sat and permanently trip `NON_CANONICAL_ANCHOR`/`AMBIGUOUS_CANONICAL` on an honest mint (deny-only — no theft). Now a competing anchoring on a different sat counts only if its inscribed did:btco document is signed by a key in the log's authorized-key history (genesis controller + rotations); the log's own anchored sat always counts. A bare or unauthorized-key back-link is ignored, so it can no longer deny a mint. Legit controller-signed dupe detection and all fail-closed behavior are preserved.
