# Plan 022: Hash-chain link must cover only committed fields, not mutable proof metadata

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report.

## Status

- **Priority**: P1 (high)
- **Effort**: S
- **Risk**: MED (changes the chain-hash preimage; pre-existing logs re-hash differently)
- **Depends on**: plan 014 (shared `canonicalizeEvent`), plan 015 (real crypto verification)
- **Category**: correctness / security
- **Planned at**: origin/main `0b8cd11`, 2026-06-22

## Why this matters

The CEL hash chain links event N to event N-1 by storing
`previousEvent = computeDigestMultibase(canonicalizeEvent(priorEvent))`.
Today every site computes that digest over the **entire prior `LogEntry`**,
including its `proof` array. But the `proof` array contains two kinds of
fields:

- `proof.proofValue` — the actual signature, which the signer committed to.
- `proof.created`, `proof.type`, `proof.cryptosuite`,
  `proof.verificationMethod`, `proof.proofPurpose` (and witness proofs added
  later) — metadata that the signer never signed.

The signed message (reconstructed in `verifyEventLog.ts` as
`{ type, data, ...(previousEvent ? { previousEvent } : {}) }`, and produced by
`createSigner`/`updateEventLog`/`deactivateEventLog` as `eventBase`) contains
**no proof fields at all**. So the chain link currently depends on
unverifiable, mutable metadata:

- An attacker who flips `proof.created` or `proof.verificationMethod` on a
  prior event changes the recomputed digest and "breaks" the chain — yet those
  fields were never committed to by any signature, so there is nothing to
  prove they were authentic in the first place. The chain reports a break that
  is not cryptographically meaningful.
- Conversely, the security property the chain *should* provide — binding the
  committed content `{type, data, previousEvent}` of every prior event — is
  diluted by mixing in fields no signature covers.
- Adding a witness proof to a prior event (an intentionally non-gating,
  append-after-the-fact operation per plan 021) mutates that event's `proof`
  array and therefore changes its chain digest, retroactively breaking every
  later link. The chain must not depend on witness proofs.

The correct preimage for the chain link is exactly the committed fields —
the same `{type, data, previousEvent}` shape the signer signs — and nothing
from `proof`.

## Current state

The digest of the prior event is computed over the whole `LogEntry` at four
sites (all under `packages/sdk/`):

- `src/cel/algorithms/updateEventLog.ts:54`
  `const previousEvent = computeDigestMultibase(canonicalizeEvent(lastEvent));`
- `src/cel/algorithms/deactivateEventLog.ts:58` — identical line.
- `src/cel/cli/transfer.ts:238` — identical line.
- `src/cel/algorithms/verifyEventLog.ts:207` (in `verifyChain`)
  `const expectedHash = computeDigestMultibase(canonicalizeEvent(previousEvent));`

`canonicalizeEvent` (`src/cel/canonicalize.ts`) is the correct recursive JCS
serializer from plan 014. `computeDigestMultibase` (`src/cel/hash.ts`) is the
correct digest function. Both stay as-is.

The signed payload shape (the committed fields) is built two ways that must
stay byte-for-byte identical to the new chain preimage:
- producers: `eventBase = { type, data, previousEvent }` (key insertion order
  is irrelevant — `canonicalizeEvent` sorts keys).
- verifier: `verifyEventLog.ts:276-280`
  `{ type, data, ...(previousEvent ? { previousEvent } : {}) }`.

The first event has no `previousEvent`; the committed shape for it is
`{ type, data }`. Producers build their `previousEvent` from the *prior*
event whose committed shape may or may not include `previousEvent` — the
helper must omit the field when it is `undefined` so the digest matches what
the verifier reconstructs for that same prior event.

### A test currently encodes the bug

`packages/sdk/tests/unit/cel/hash-chain-tamper.test.ts` has a case
(`"tampering proofValue inside event 0's proof breaks the chain at event 1"`,
~lines 133-152) that asserts mutating `proof[0].proofValue` sets
`events[1].chainValid === false`. That is the buggy behavior: proof fields
must NOT be in the chain preimage. After the fix, tampering `proofValue` is
caught by **signature verification** (`proofValid: false`), not by the chain.
This test must be updated to reflect the correct contract.

## Scope

**In scope** (the only files to modify/create):
- `packages/sdk/src/cel/canonicalize.ts` — add `canonicalizeEntryForChain`.
- `packages/sdk/src/cel/index.ts` — export it (if `canonicalizeEvent` is exported there).
- `packages/sdk/src/cel/algorithms/updateEventLog.ts`
- `packages/sdk/src/cel/algorithms/deactivateEventLog.ts`
- `packages/sdk/src/cel/cli/transfer.ts`
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
- `packages/sdk/tests/unit/cel/hash-chain-tamper.test.ts` — update the
  `proofValue` case + add a `proof.created` metadata-mutation regression case.
- `plans/README.md` (status row only)

**Out of scope**: `hash.ts`, `canonicalizeEvent` itself, the VC subsystem,
file-I/O serialization (`serialization/*.ts`), witness signing.

## Steps

### Step 1: Add the chain-preimage helper

In `src/cel/canonicalize.ts`, add and export:

```typescript
import type { LogEntry } from './types';

/**
 * Extracts the *committed* fields of a log entry — exactly the message the
 * signer signs (`{ type, data, previousEvent? }`) — for use as the hash-chain
 * preimage. The `proof` array is deliberately excluded: it carries both the
 * signature (`proofValue`) and unsigned, mutable metadata (`created`,
 * `verificationMethod`, witness proofs added later). Chaining over those
 * fields would make the chain link depend on data no signature commits to.
 */
export function canonicalizeEntryForChain(entry: LogEntry): Uint8Array {
  const committed: { type: unknown; data: unknown; previousEvent?: unknown } = {
    type: entry.type,
    data: entry.data,
  };
  if (entry.previousEvent !== undefined) {
    committed.previousEvent = entry.previousEvent;
  }
  return canonicalizeEvent(committed);
}
```

(If `canonicalize.ts` cannot import `LogEntry` without a cycle, type the param
as `{ type: unknown; data: unknown; previousEvent?: unknown }` instead.)

Export from `src/cel/index.ts` next to `canonicalizeEvent` if present.

**Verify**: `cd packages/sdk && bunx tsc --noEmit` → exit 0.

### Step 2: Switch all four hash sites to the helper

Replace `canonicalizeEvent(lastEvent)` / `canonicalizeEvent(previousEvent)`
with `canonicalizeEntryForChain(...)` at:
- `updateEventLog.ts:54`
- `deactivateEventLog.ts:58`
- `cli/transfer.ts:238`
- `verifyEventLog.ts:207`

Add the import `canonicalizeEntryForChain` from `../canonicalize` to each
(verifyEventLog/updateEventLog/deactivateEventLog) and `../canonicalize` for
the CLI file. Keep the existing `canonicalizeEvent` import where it is still
used (e.g. verifyEventLog still uses it for the signed-message check).

**Verify**: `grep -rn "canonicalizeEvent(lastEvent)\|canonicalizeEvent(previousEvent)" packages/sdk/src/cel/`
→ no matches.

### Step 3: Fix the tamper test contract + add metadata regression

In `tests/unit/cel/hash-chain-tamper.test.ts`:

- Replace the `proofValue` case so it asserts the corrected contract: mutating
  `events[0].proof[0].proofValue` does NOT break the chain
  (`events[1].chainValid === true`) but IS caught by signature verification —
  use the **real** Ed25519 signer for this case and assert
  `events[0].proofValid === false` and overall `verified === false`.
- Add a new case: mutating `events[0].proof[0].created` (pure unsigned
  metadata) does NOT change `events[1].chainValid` (stays `true`). With the
  real signer the proof itself still verifies because `created` is not in the
  signed message either, so `verified` stays `true`. This is the regression
  that fails before the fix (old code breaks the chain on a `created` change)
  and passes after.
- Keep the nested-data and top-level-name cases unchanged (they must still
  break the chain — `data` IS committed).

**Verify**: `cd packages/sdk && bun test tests/unit/cel/hash-chain-tamper.test.ts`
→ all pass. Confirm the `created` case fails when Step 2 is reverted.

### Step 4: Full CEL + suite check

**Verify**:
- `cd packages/sdk && bunx tsc --noEmit` → 0 errors
- `bun run build` → succeeds
- `bun test` (SDK + auth) → 0 failures

## Done criteria

- [ ] Chain preimage excludes the `proof` array at all four sites.
- [ ] `created` / `verificationMethod` mutations on a prior event no longer
      affect `chainValid`.
- [ ] `proofValue` tampering is caught by `proofValid`, not by the chain.
- [ ] Nested `data` tampering still breaks the chain.
- [ ] tsc 0, build ok, full test suite 0-fail.

## STOP conditions

- Any committed fixture embeds precomputed `previousEvent` hashes from the old
  (proof-inclusive) preimage and cannot be regenerated.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This changes the chain-link preimage, so logs hashed by the old code will
  re-hash differently. Same caveat as plan 014: re-create/re-hash logs at
  ≥ this version. Combined with plan 021 (non-gating witness proofs), the chain
  now correctly ignores witness proofs appended to prior events.
