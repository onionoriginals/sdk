# 030 - Fix MigrationFailedEvent.error type contract drift

## Finding

[high] Event payload contract drift: `MigrationFailedEvent.error` type mismatch.

`MigrationFailedEvent` (in `packages/sdk/src/events/types.ts`) declares:

```ts
error: Error | { message: string; code?: string };
```

But the actual emitter at `MigrationManager.ts:400` emits a `MigrationError`
object (see `packages/sdk/src/migration/types.ts:166`) with fields:
`type`, `code`, `message`, `technicalDetails?`, `suggestedRecovery?`,
`migrationId?`, `sourceDid?`, `targetDid?`, `timestamp`, `stack?`.

This is a contract drift: subscribers typed against the interface receive an
object with unexpected fields, and key shape differences (e.g. `code` is
declared optional but is always present as a required `string` on
`MigrationError`; `type`/`timestamp` are required on `MigrationError` but absent
from the declared union). A subscriber relying on an `error instanceof Error`
check would also be misled — the runtime value is a plain object, never an
`Error` instance.

## Root cause

The event interface was authored independently of the emitter and was never
aligned with the real `MigrationError` payload that `MigrationManager`
constructs and emits.

## Fix (minimal, correct)

Change `MigrationFailedEvent.error` to be typed as the actual emitted payload,
`MigrationError`, imported from `../migration/types`. This makes the declared
event contract match the implementation exactly, restoring type safety for
event handlers.

```ts
import type { MigrationError } from '../migration/types';

export interface MigrationFailedEvent extends BaseEvent {
  type: 'migration:failed';
  migrationId: string;
  error: MigrationError;
}
```

## Regression test

Add a test in `packages/sdk/tests/unit/events/EventContracts.test.ts` (the
existing golden-contract suite) that constructs the *actual* `MigrationError`
payload shape that `MigrationManager` emits and asserts (via `satisfies
MigrationFailedEvent`) that it is assignable to the event interface. Before the
fix this fails to type-check (`tsc --noEmit` errors); after the fix it passes.
The existing "exactly the declared fields" test for `MigrationFailedEvent` is
updated to use the real `MigrationError` shape.

## Green invariant

```
bunx tsc --noEmit   # 0 errors
bun run build       # succeeds
bun run test        # 0 failures
```
