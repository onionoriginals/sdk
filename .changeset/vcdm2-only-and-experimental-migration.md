---
"@originals/sdk": patch
---

Standardize on W3C VCDM 2.0 and mark the migration subsystem experimental.

**BREAKING (#300 — VCDM 2.0 only):** `validateCredential` now requires the
`https://www.w3.org/ns/credentials/v2` context and rejects credentials that
present only the VCDM 1.1 (`https://www.w3.org/2018/credentials/v1`) context
(reversing the 1.1 acceptance added in #264). All SDK-emitted credentials now use
the 2.0 context and the `validFrom` timestamp instead of `issuanceDate`:
resource credentials, chained credentials, presentations, Bitstring status-list
credentials, and key-recovery credentials. The 1.1 JSON-LD context remains
preloaded so previously-issued 1.1 credentials can still be read/verified
cryptographically, but it is no longer accepted at the structural gate. The
`VerifiableCredential` type gains optional `validFrom`/`validUntil` and marks
`issuanceDate`/`expirationDate` as deprecated legacy fields. Fixes a latent
signing bug where `StatusListManager` emitted a v2 context with `issuanceDate`,
a term the v2 context does not define (safe-mode canonicalization would fail).

**BREAKING (#279 — migration subsystem experimental):** `MigrationManager` is no
longer re-exported from the package entry point. It is experimental and unused in
production — `OriginalsSDK`/`LifecycleManager` run their own migration flow and
never use it — so its checkpoint/rollback/audit machinery protected no production
path. It remains importable from its module path for experimentation. Only the
`MigrationError` type stays exported (the public event API references it).
