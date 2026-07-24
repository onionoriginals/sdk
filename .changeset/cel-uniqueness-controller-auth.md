---
"@originals/sdk": patch
---

Fix a deny-only front-running weakness in did:cel first-anchor-wins uniqueness (#402). `verifyUniqueness` counted **any** inscription that back-linked the did:cel via `alsoKnownAs`, so a non-controller could inscribe `{alsoKnownAs:["did:cel:Z"]}` on their own earlier sat and permanently trip `NON_CANONICAL_ANCHOR`/`AMBIGUOUS_CANONICAL` on an honest mint (deny-only — no theft). Now a competing anchoring on a different sat is only counted when it is controller-authenticated; a bare or unauthorized-key back-link is ignored, so it can no longer deny a mint. The log's own anchored sat always counts, and all fail-closed behavior is preserved.

Note: signing the did:btco document to authenticate honest competitors was considered and rejected as non-conformant with the BTCO DID Method (DID documents aren't self-signed — #442 closed). Conformant did:btco docs are therefore unsigned, so honest cross-sat competitors are also dropped and legit dupe detection is off — a no-attacker gap (an attacker can't forge a valid competing anchoring), not a security loss. A method-conformant dupe check would authenticate via the witnessed CEL migrate event.
