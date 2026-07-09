# 028 — witnessEvent must use the chain canonicalization (cross-tool serialization consistency)

## Finding (as reported)

[high] Inconsistent serialization between hash chain creation and verification
(`packages/sdk/src/cel/algorithms/witnessEvent.ts`).

> The code paths for computing event digests are inconsistent. `updateEventLog`
> and `verifyEventLog` both use `canonicalizeEntryForChain()` which correctly
> excludes proofs from the hash input. However, `witnessEvent` uses a custom
> `serializeEntry()` that includes the entire entry. This means the digest
> computed in `witnessEvent` does not match what the verifier expects, leading to
> a split-brain where witness digests are computed over different data than chain
> hashes.

## Investigation result (defect confirmed on origin/main)

Confirmed present at base commit `f1f45ec`.

- `packages/sdk/src/cel/canonicalize.ts` exports `canonicalizeEntryForChain(entry)`,
  which canonicalizes ONLY the committed fields `{ type, data, previousEvent? }`
  and deliberately excludes the `proof` array. This is the single serialization
  used everywhere a digest of an event must be agreed upon:
  - `algorithms/updateEventLog.ts` (`previousEvent` link)
  - `algorithms/deactivateEventLog.ts` (`previousEvent` link)
  - `algorithms/verifyEventLog.ts` (expected previous-event hash)
  - `cli/transfer.ts` (`previousEvent` link)
- `algorithms/witnessEvent.ts` instead defined a private `serializeEntry(entry)`
  that runs `JSON.stringify` over the **entire** `LogEntry`, INCLUDING the `proof`
  array. The digest handed to the witness service therefore commits to the proof
  metadata (`created`, `verificationMethod`, `proofValue`, and any previously
  appended witness proofs) — data that no chain link or controller signature
  commits to.

### Why this is a real cross-tool interoperability defect

A witness attests to "the event identified by digest D". Every other producer and
verifier in the SDK (and, per the audit scope, an external CLI) identifies an event
by `computeDigestMultibase(canonicalizeEntryForChain(event))` — the proof-excluded
digest that is also the `previousEvent` chain link. Because `witnessEvent` witnessed
a *different* digest (proof-inclusive), a witness attestation produced by the SDK
cannot be correlated with the chain digest used by the CLI (or by `updateEventLog`/
`verifyEventLog`), and the digest is unstable: appending a second witness proof
changes the proof array and would change the digest of the "same" event. This is the
exact "split-brain" / cross-tool serialization inconsistency the finding describes.

## Fix (minimal)

Delete the bespoke `serializeEntry()` and compute the witnessed digest with the
shared `canonicalizeEntryForChain(event)` — the same preimage used for chain links
and reconstructed by the verifier. No other behavior changes; the witness proof is
still appended immutably to `event.proof`.

## Regression test (fails before / passes after)

`packages/sdk/tests/unit/cel/witnessEvent.test.ts` — new `describe('digest consistency …')`:

1. The digest passed to the witness service equals
   `computeDigestMultibase(canonicalizeEntryForChain(event))` (the chain digest) for
   a first event (`{ type, data }`, no `previousEvent`).
2. The same holds for an event WITH `previousEvent` (`{ type, data, previousEvent }`).
3. The witnessed digest is **independent of the proof array**: two events that are
   identical in `{ type, data, previousEvent }` but differ in their `proof` contents
   are witnessed over the same digest. (Fails on the old proof-inclusive serializer.)

## Verification

`bunx tsc --noEmit` clean, `bun run build` succeeds, `bun run test` 0-fail.
