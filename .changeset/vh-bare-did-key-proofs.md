---
'@originals/vh': patch
---

Accept an entry proof whose `verificationMethod` is a bare `did:key:<multikey>`, as VH-Log's "Authorized Keys" allows and didwebvh-ts signers produce. Witness proofs still need `did:key:<multikey>#<multikey>`. This fixes signed-in landing authors, whose did:webvh logs failed verification as identity evidence.
