---
"@originals/code": minor
---

Branch segments (plan 049 O1, K13): a branch longer than the entry limit becomes a chain of segment Originals, each genesis naming the previous segment's did and last versionId. The repo document lists the newest segment, bundles carry every segment, and the verifier walks the chain, checking continuity of commits and roots and reporting each segment.
