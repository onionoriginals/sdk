---
"@originals/sdk": minor
---

Batch of independent review fixes (#302, #304, #305, #306, #310, #314, #329):

- **#310 (breaking for multi-sig external signers):** multi-sig external-signer contributions were unverifiable — the signer canonicalized itself (JCS) while verification hashes RDFC-2022. The SDK now canonicalizes+hashes and the signer signs those exact bytes via a new optional `ExternalSigner.signBytes(data)`; a signer implementing only the document-level `sign()` is refused up front. did:webvh signing and all other `sign()` usage are unaffected.
- **#306:** multi-sig signing rejects non-Ed25519 signer keys with a clear upfront error, and verification reports a distinguishing "unsupported/legacy proof format" message instead of a generic "Invalid signature".
- **#305:** multi-sig proofs are verified concurrently over one shared document loader (deterministic post-collection dedupe; results unchanged).
- **#304:** the status list credential's proof verification is memoized on the full resolved document (positives-only, TTL-bounded), avoiding N re-verifications of one shared list.
- **#302:** rollback reports `PARTIALLY_ROLLED_BACK` whenever the failure error carries on-chain artifacts, regardless of the tracked pre-anchoring state.
- **#314:** added the exported `witnessSigningBytes(digest)` helper and documented the CEL witness signing-byte contract.
- **#329:** `listObjects(domain, prefix)` is now an optional, documented member of the public `StorageAdapter` interface (additive).
