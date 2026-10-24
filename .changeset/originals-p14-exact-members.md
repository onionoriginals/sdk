---
'@originals/vh': minor
'@originals/sdk': patch
---

Originals asset entries are held to section 14's exact members (P14.1, P14.4, P14.8; P14.8's explicit wording is originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges): parameters are exactly `method` and `scid` at genesis, `{"deactivated": true}` for a deactivation and `{}` otherwise (`PARAMETER_MEMBERS`; `ttl`, `watchers`, `witness: {}`, `deactivated: false` and a repeated `method` were accepted before), and an entry proof has exactly `type`, `cryptosuite`, `verificationMethod`, `proofPurpose` and `proofValue` (`PROOF_MEMBERS`; `created`, `expires`, `id`, `domain`, `challenge`, `nonce`, `previousProof` and `@context` are rejected). did:webvh and did:vh signer logs are unaffected.
