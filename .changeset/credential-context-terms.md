---
"@originals/sdk": patch
---

Define the `ResourceMigrated` credential's subject terms in the Originals JSON-LD context (#371). `LifecycleManager.publishToWeb` emits a `ResourceMigrated` credential (attached to `asset.credentials`) whose subject keys — `migratedTo`, `resourceId`, `fromLayer`, `toLayer`, `migratedAt` — the declared `https://originals.build/context` didn't define, so `@vocab` silently absorbed them into a different namespace (`…/vocab#X`) than the explicitly-defined terms (`…/X`). The context now defines them, and a test asserts the emitted `ResourceMigrated` credential's type + every subject key is explicit, guarding against a new field shipping without a context entry.

Scoped to `ResourceMigrated` because it is the only credential the live lifecycle emits — verification is CEL-based (`verifyEventLog` never reads credentials), and the other `CredentialManager` factories (`MigrationCompleted`/`OwnershipTransferred`/`ResourceCreated`/`ResourceUpdated`) and `KeyRecoveryCredential` have no internal callers. Whether that legacy VC surface stays is the VC-vs-CEL question in #370/#405.
