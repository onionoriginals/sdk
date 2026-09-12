---
"@originals/sdk": major
---

**Ordinary credential verification no longer silently skips revocation checking** (#600).

`CredentialManager.verifyCredential` hardcoded `checkStatus: false`, and `UnifiedVerifier`'s credential branch did the same — a credential that declared a `credentialStatus` verified as `true` on signature alone, with no way for a caller to tell that revocation was never evaluated. Similarly, `UnifiedVerifier`'s event-log branch never reported whether btco head-freshness actually ran.

- `CredentialManager.verifyCredential` is now safe by default: when the credential declares a `credentialStatus`, it is checked via the new `CredentialManager.statusListResolver` (settable on the instance); with no resolver configured, a credential that declares a status entry now fails closed instead of silently passing.
- The previous signature-only behavior is now an explicitly-named entry point, `CredentialManager.verifyCredentialSignature` — for offline/proof-only verification, or internal reuse (checking a status list credential's own signature) where recursing into status checking would be redundant or incorrect.
- `UnifiedVerifier.verify()` now returns an `assurance` field (`{ signature, status, freshness }`, each `'checked' | 'failed' | 'unknown'`) alongside `verified`, so a caller can tell "checked and passed" apart from "not checked at all" instead of reading a bare boolean. A new `UnifiedVerifierOptions.statusListResolver` lets the credential branch actually check status; a new `signatureOnly` option explicitly opts out of status/freshness checking (reported `unknown`, never silently `checked`) rather than that being the unnamed default.

Breaking because `CredentialManager.verifyCredential` and `UnifiedVerifier.verify()` on a credential that declares `credentialStatus` no longer verify on signature alone — configure `statusListResolver`, or use the explicitly-named signature-only entry point if that's genuinely what's wanted.
