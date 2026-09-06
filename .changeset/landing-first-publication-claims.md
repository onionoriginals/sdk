---
"@originals/landing": patch
---

**Fix: the page claims first publication, and names the index its Bitcoin reads depend on.**

Two overclaims, from the protocol design review.

**"Proof you made it" is not what the protocol proves.** It proves that a key signed this content hash, that Bitcoin timestamped that signature, and that this key anchored this log first. Nothing binds the key to a person, and identity is the hash of the genesis event — so someone can pull a file off Twitter, mint it, inscribe first, and hold a proof that verifies exactly as green as the creator's, and earlier. The protocol has no answer to that and cannot have one.

Priority of publication is the real claim, and it sells fine. The headline, page title, meta description, hero subhead and Why headline now say first publication and timestamping rather than authorship.

**"Anyone can verify the whole chain — without trusting you, us, or any platform" was false.** Every on-chain fact in the verify path — which inscriptions sit on a sat, their block heights, their content — comes from an Ordinals indexer. There is no header chain and no SPV anywhere in it, so a dishonest index can hide the newest anchor, hide a competing earlier anchoring, or misreport heights, all undetectably.

The provenance card now separates the two halves: the signature checks are genuinely trustless and say so, and the Bitcoin reads name the index they depend on. Stated plainly rather than softened into "decentralized infrastructure".

**"If we vanish tomorrow, your provenance still verifies" was true only sometimes** — for an inscribed asset whose log someone kept. A pre-anchor asset is bytes on this host and dies with it. The claim is now conditioned on both, and points at the export.

The protocol section also says which of the three method names are actually standards: `did:webvh` and `did:btco` are registered DID methods, `did:cel` is ours and is not.

Tests pin the shape of each claim rather than its wording, so a future copy pass can rewrite freely but not back into any of them.
