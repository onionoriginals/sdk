---
"@originals/sdk": major
---

**`credentialStatus` arrays no longer bypass revocation/status checking** (#592).

VCDM 2.0 permits `credentialStatus` to be a single object or an array of them. Every status-checking path — `Verifier.checkCredentialStatus` / `verifyCredential`, the multi-sig verification path (both in `Verifier` and `MultiSigManager`), and `CredentialManager.verifyCredentialWithStatus` — read it as a singleton (`(vc.credentialStatus as BitstringStatusListEntry)?.type`), so an array-shaped value read `.type` as `undefined` and skipped status checking entirely, including the existing fail-closed "no resolver configured" branch. A credential whose `credentialStatus` was wrapped in a one-element array verified as not-revoked regardless of its actual status.

- Added `credentialStatusEntries()` (`packages/sdk/src/vc/credentialStatus.ts`), the single normalization helper every status-checking path now reads `credentialStatus` through instead of casting it to a singleton.
- Every declared entry is evaluated, not just the first: a mix of a clean entry and a revoked/unsupported one still fails the credential.
- An entry whose `type` is not `BitstringStatusListEntry` now fails closed with an explicit "unsupported credentialStatus type" error instead of being silently ignored — previously true for a singleton unsupported type too, not only for arrays.
- `CredentialManager`'s revoke/suspend/check-status management methods (which take one caller-supplied status list) now require the credential to declare exactly one `credentialStatus` entry, rejecting an array rather than guessing which entry to act on.
- A malformed array element (not an object, or with no string `type`) now fails the credential closed with an explicit "malformed credentialStatus entry" error instead of risking an unhandled `TypeError`.
- `CredentialManager.verifyCredentialWithStatus`'s `statusListCredential` parameter now also accepts an array, so entries that reference different status lists (e.g. separate revocation and suspension lists) can each be matched to the list they actually name and verified in one call; single-credential callers are unaffected.

`VerifiableCredential.credentialStatus` is now typed `CredentialStatus | CredentialStatus[]`. Breaking because a credential that previously verified only because its declared status was unreachable through the old singleton cast — array-shaped, or a singleton of an unsupported type — no longer verifies.
