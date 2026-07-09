---
"@originals/sdk": patch
---

Enforce real credential verification in the migration ValidationPipeline (#283). `CredentialValidator` now cryptographically verifies each signed credential via `CredentialManager` and fails hard (`CREDENTIAL_VERIFICATION_FAILED`) on tampered/forged credentials; real credentials flow through `migrate()` via a typed `MigrationOptions.credentials` channel instead of the never-populated `metadata.credentials`.
