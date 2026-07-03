---
"@originals/sdk": minor
---

Fix six correctness bugs surfaced by a fresh subsystem audit, each with regression coverage. Two change verification behavior toward fail-closed:

- **Revocation fail-open (security).** `CredentialManager.verifyCredentialWithStatus` now fails closed (`verified: false`) when a credential declares a `BitstringStatusListEntry` that cannot be evaluated — no status list supplied, or `checkStatus` throws (purpose mismatch, out-of-range index, corrupt list). Previously it returned `verified: true` / `revoked: false`, so a caller could treat a possibly-revoked credential as valid. Determinable revoked/suspended states are unchanged.
- **Issuer binding on the legacy verify path.** The legacy `verifyCredential` path now rejects a signed credential that has no issuer to bind the signing key to, matching the Data Integrity path (which already fails closed). Previously a self-certifying `did:key` credential with no `issuer` verified unconditionally.
- **Resource version lookup.** `ResourceManager.getResourceVersion` now matches by stored version number instead of array position, so non-contiguous histories (e.g. importing v1 then v3) return the correct version rather than aliasing or dropping one.
- **`did:btco` tombstone detection.** `BtcoDidResolver` no longer misclassifies a valid DID document that merely contains the 🔥 codepoint in a field as a deactivation tombstone; only the human-readable marker form deactivates a DID.
- **Network-scoped `did:btco` in CEL state.** `BtcoCelManager.getCurrentState` now derives the network-scoped identifier (`did:btco:reg:` / `did:btco:sig:` for regtest/signet) from the inscribing `BitcoinManager` instead of always emitting the mainnet form.
- **Multibase decoding.** `multikey.decodeMultibase` now accepts `u` (base64url) in addition to `z` (base58btc), matching the CEL proof structural check so a spec-valid base64url signature is no longer rejected. Unknown prefixes still fail closed.
