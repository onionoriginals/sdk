# 028 — Witness digest must cover committed fields only, not the proof array

## Finding (as reported)

[critical] Witness digest calculated from full event including proofs instead of
committed fields only (`packages/sdk/src/cel/algorithms/witnessEvent.ts`).

> The `witnessEvent` function uses `serializeEntry(event)` which includes the entire
> `LogEntry` including the `proof` array. According to the CEL specification and the
> `canonicalize.ts` specification, the witness digest should only include the committed
> fields (`type`, `data`, `previousEvent`), not the mutable `proof` array. This breaks
> the security model where witnesses attest to immutable event data, not to proof
> metadata that can be added/modified later.

## Investigation result

The defect is real and present on `origin/main` (base commit `334d0ec`).

`witnessEvent` computed its digest like this:

```ts
const eventBytes = serializeEntry(event);          // serializes the WHOLE LogEntry
const digestMultibase = computeDigestMultibase(eventBytes);
```

`serializeEntry` is a local, recursive (JCS-style) serializer — but it serializes the
**entire** `LogEntry`, including the `proof` array. The `proof` array carries unsigned,
mutable metadata (`created`, `verificationMethod`, `proofPurpose`) and any witness
proofs appended later. So the witness ends up attesting to a digest over data no
signature commits to.

This contradicts the codebase's own canonicalization contract in
`packages/sdk/src/cel/canonicalize.ts`: `canonicalizeEntryForChain(entry)` deliberately
includes only `{ type, data, previousEvent? }` and excludes `proof` for exactly this
reason. The chain-link computation (`updateEventLog`, `deactivateEventLog`,
`verifyEventLog`) already uses `canonicalizeEntryForChain`. The witness digest must use
the same committed-fields preimage so that:

1. Appending a witness proof to an event does not retroactively change that event's
   witness digest (idempotent, order-independent attestation).
2. Witnesses attest to the immutable event content, not to mutable proof metadata.

## Fix

In `packages/sdk/src/cel/algorithms/witnessEvent.ts`:

- Remove the local `serializeEntry` helper.
- Import and use `canonicalizeEntryForChain` from `../canonicalize` to build the digest
  preimage from committed fields only (`type`, `data`, `previousEvent`).

This is the minimal change that aligns the witness digest with the documented
committed-fields contract and the rest of the CEL hash-chain code.

## Regression test (fails before / passes after)

Added to `packages/sdk/tests/unit/cel/witnessEvent.test.ts` a `digest scope` block that
captures the `digestMultibase` passed to the witness service and asserts:

1. Witnessing an event yields the same digest as witnessing the same event with a
   **different/mutated `proof` array** (e.g. an extra appended proof, or changed
   `proof.created`/`verificationMethod`). The proof array must not affect the digest.
2. The digest equals `computeDigestMultibase(canonicalizeEntryForChain(event))`
   (committed fields only), confirming the exact preimage.

Before the fix these assertions fail (the digest changes with the proof array and does
not match the committed-fields preimage). After the fix they pass.

## Verification

- `bunx tsc --noEmit` — 0 errors
- `bun run build` — succeeds
- `bun run test` — SDK + auth suites 0-fail
