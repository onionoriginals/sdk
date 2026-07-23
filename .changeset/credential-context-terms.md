---
"@originals/sdk": patch
---

Define every credential term in the Originals JSON-LD context (#371). The credential factory emitted `MigrationCompleted`, `OwnershipTransferred`, and `KeyRecoveryCredential` types — plus subject properties like `fromLayer`/`toLayer`/`previousOwner`/`newOwner` — that the declared `https://originals.build/context` didn't define, so they were silently absorbed by `@vocab` into a different namespace (`…/vocab#X`) than the explicitly-defined terms (`…/X`). The context now defines all factory-emitted credential types and subject properties consistently, and a new test issues one of every credential and asserts each type + subject key is explicitly defined — guarding against a new credential field shipping without a context entry.
