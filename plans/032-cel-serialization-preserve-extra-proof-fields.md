# Plan 032: Preserve extra proof fields (Bitcoin witness anchors) in CEL JSON/CBOR deserialization

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note it).
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Worktree branches from `origin/main` (`correctness/round1-3`). At the worktree root:
1. `bun install --frozen-lockfile || bun install`.
2. Baseline: `bunx tsc --noEmit` → exit 0; `bun run test` → existing suites pass.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: bug (data loss / serialization round-trip) / correctness
- **Planned at**: `origin/main` @ `8881c1d`, 2026-06-23

## Why this matters

`BitcoinWitness.witness()` (`packages/sdk/src/cel/witnesses/BitcoinWitness.ts`)
produces a `BitcoinWitnessProof` that extends `WitnessProof` with four
Bitcoin-specific provenance fields: `txid`, `satoshi`, `inscriptionId`, and
optional `blockHeight`. `BtcoCelManager.migrate()` embeds these proofs in
migration events to permanently record the Bitcoin inscription that anchors the
event.

Both deserialization parsers (`parseProof` in `json.ts` and `cbor.ts`)
reconstruct a proof from a **hard-coded allow-list** of fields
(`type`, `cryptosuite`, `created`, `verificationMethod`, `proofPurpose`,
`proofValue`, and — for witnesses — `witnessedAt`). Every other key is silently
dropped. So when an `EventLog` containing a Bitcoin witness proof is serialized
(`serializeEventLogJson` / `serializeEventLogCbor`) and then parsed back
(`parseEventLogJson` / `parseEventLogCbor`), `txid`, `satoshi`, `inscriptionId`,
and `blockHeight` are **permanently lost**. This breaks the immutable provenance
chain: the Bitcoin anchor information becomes inaccessible after a single
round-trip, and the canonical hash of any re-serialized log no longer matches the
original.

The canonical `DataIntegrityProof` type also declares optional fields `id` and
`previousProof` (`src/types/proof.ts`) which are likewise dropped today.

Decision: preserve **all** extra proof fields through deserialization. Keep the
existing strict validation of the known required fields (they must still be
present and correctly typed), but carry through any additional keys verbatim so
extension proofs (Bitcoin witness, proof chains, `id`) round-trip losslessly.

## Current state

`parseProof` in both `json.ts` and `cbor.ts` builds the result from a fixed set
of keys:

```typescript
const baseProof: DataIntegrityProof = {
  type: p.type,
  cryptosuite: p.cryptosuite,
  verificationMethod: p.verificationMethod,
  proofPurpose: p.proofPurpose,
  proofValue: p.proofValue,
};
// created added if present; witnessedAt added for witness proofs;
// ALL OTHER KEYS (txid, satoshi, inscriptionId, blockHeight, id, previousProof) DROPPED.
```

## Scope

**In scope:**
- `packages/sdk/src/cel/serialization/json.ts` (`parseProof`: preserve extra fields)
- `packages/sdk/src/cel/serialization/cbor.ts` (`parseProof`: preserve extra fields)
- `packages/sdk/tests/unit/cel/json-serialization.test.ts` (regression test)
- `packages/sdk/tests/unit/cel/cbor-serialization.test.ts` (regression test)

**Out of scope:**
- Adding validation of the Bitcoin-specific field *values* (the parser is a
  structural boundary; the witness fields are extension data).
- Changing the `WitnessProof` / `BitcoinWitnessProof` type definitions.
- Any field's existing required-presence validation (unchanged).

## Steps

### Step 1: json.ts — preserve extra fields
In `parseProof`, after validating the required fields, build the reconstructed
proof by spreading the original object first so extra keys survive, then assign
the validated known fields to guarantee their narrowed types:

```typescript
// Preserve any extension fields (e.g. Bitcoin witness anchors txid/satoshi/
// inscriptionId/blockHeight, proof-chain id/previousProof) by carrying through
// every key. Known required fields are re-assigned after validation so their
// types are narrowed correctly.
const baseProof = {
  ...(p as Record<string, unknown>),
  type: p.type,
  cryptosuite: p.cryptosuite,
  verificationMethod: p.verificationMethod,
  proofPurpose: p.proofPurpose,
  proofValue: p.proofValue,
} as DataIntegrityProof;
if (typeof p.created === 'string') {
  baseProof.created = p.created;
}
```

Keep the existing `witnessedAt` branch; since `witnessedAt` is now already
carried through by the spread, the branch only needs to validate its type and
return `baseProof` typed as `WitnessProof` (or simply keep the existing
`{ ...baseProof, witnessedAt: p.witnessedAt }` — both are equivalent now).

### Step 2: cbor.ts — identical change
Apply the same spread-then-assign reconstruction to `cbor.ts`'s `parseProof`.

### Step 3: Regression tests
In both `json-serialization.test.ts` and `cbor-serialization.test.ts`, add a test
that builds an `EventLog` whose entry carries a Bitcoin witness proof with
`txid`, `satoshi`, `inscriptionId`, and `blockHeight`, round-trips it through
serialize→parse, and asserts all four fields survive (plus `witnessedAt`).

This test FAILS before the fix (fields are `undefined` after parse) and PASSES
after.

## Done criteria (ALL must hold)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run build` succeeds
- [ ] Bitcoin witness proof fields (`txid`, `satoshi`, `inscriptionId`,
      `blockHeight`) survive a JSON round-trip
- [ ] Same fields survive a CBOR round-trip
- [ ] Existing required-field validation still rejects malformed proofs
- [ ] `bun run test` — SDK + auth suites 0 fail
- [ ] No out-of-scope files modified

## STOP conditions
- An existing test relies on extra proof fields being stripped during parse
  (would surface as a failing existing test) — report rather than weaken.
