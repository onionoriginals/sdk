---
"@originals/sdk": patch
---

Credential verification hardening: the legacy verification path now fails closed for revoked/compromised verification methods (no `resolveDID` fallback that ignored retirement markers), and Data Integrity proofs must declare `type: "DataIntegrityProof"` — `verifyProof` rejects a mismatched/missing proof type and `createProof` throws symmetrically.
