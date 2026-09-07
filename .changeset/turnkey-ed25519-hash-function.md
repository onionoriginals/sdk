---
"@originals/auth": patch
"@originals/landing": patch
---

**Turnkey signing was rejected outright on Ed25519 keys.**

`turnkeySignBytes` sent `hashFunction: 'HASH_FUNCTION_NO_OP'`. Turnkey refuses that combination:

```
cannot use hash function NoOp to produce ed25519 signature
```

Ed25519 takes the message itself and hashes internally as part of the signature scheme, so there is no pre-hash slot to declare as a no-op — that enum belongs to the ECDSA curves, where a caller may hand over a digest. The correct value is `HASH_FUNCTION_NOT_APPLICABLE`, which expresses the same intent the code always had: the SDK owns canonicalization, and Turnkey signs the given bytes verbatim.

This is the one place Turnkey actually signs, so it blocked **every** Turnkey-authored signature: creating an Original on the deployed landing page, and signing a user's `did:webvh` log.

The existing test captured the call's parameters but never asserted `hashFunction`, so a local stub accepted a value the real API rejects. It now asserts it.
