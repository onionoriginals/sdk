# Plan 025: Make CEL proof `created` optional in JSON/CBOR deserialization (match the type + creation path)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note it).
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Worktree branches from `origin/main` (`correctness/round1-2`). At the worktree root:
1. `bun install --frozen-lockfile || bun install`.
2. Baseline: `bunx tsc --noEmit` → exit 0; `bun run test` → existing suites pass.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Category**: bug (type/serialization mismatch) / correctness
- **Planned at**: `origin/main` @ `5dd0d44`, 2026-06-22

## Why this matters

`DataIntegrityProof.created` is declared **optional** (`created?: string`) in
`packages/sdk/src/types/proof.ts:21`. The creation path agrees: `createEventLog`
(`src/cel/algorithms/createEventLog.ts:51`) validates only `type`, `cryptosuite`,
`proofValue` — never `created`. A `CelSigner` is therefore permitted to return a
valid proof with `created` omitted, and `createEventLog`/`updateEventLog` will
accept it into an `EventLog`.

But both deserialization parsers **require** `created` to be a present string:
- `src/cel/serialization/json.ts:84-85` throws `Invalid proof: missing or invalid created`.
- `src/cel/serialization/cbor.ts:35-36` throws the same.

Consequence: a valid in-memory log can be **un-serializable round-trip** — it
serializes fine (serialization just key-sorts/encodes the object), but
re-parsing the JSON/CBOR throws. This breaks the provenance layer's lossless
cross-tool (SDK ↔ CLI) transport/storage requirement. The CLI already treats
`created` as optional for display (`src/cel/cli/verify.ts:87` prints `N/A` when
absent), confirming the intended contract is "optional".

Decision: make the parsers treat `created` as **optional**, consistent with the
type and the creation path. When present it must still be a string (reject a
non-string `created`); when absent, omit it from the reconstructed proof.

## Current state

`parseProof` in both `json.ts` and `cbor.ts` is identical for the `created`
handling:

```typescript
if (typeof p.created !== 'string') {
  throw new Error('Invalid proof: missing or invalid created');
}
...
const baseProof: DataIntegrityProof = {
  type: p.type,
  cryptosuite: p.cryptosuite,
  created: p.created,      // unconditionally set
  verificationMethod: p.verificationMethod,
  proofPurpose: p.proofPurpose,
  proofValue: p.proofValue,
};
```

`type`, `cryptosuite`, `verificationMethod`, `proofPurpose`, `proofValue` remain
genuinely required (all non-optional in the type) — do NOT relax those.

## Scope

**In scope:**
- `packages/sdk/src/cel/serialization/json.ts` (`parseProof`: optional `created`)
- `packages/sdk/src/cel/serialization/cbor.ts` (`parseProof`: optional `created`)
- `packages/sdk/tests/unit/cel/json-serialization.test.ts` (regression test)
- `packages/sdk/tests/unit/cel/cbor-serialization.test.ts` (regression test)

**Out of scope:**
- Relaxing any other required field.
- Changing `createEventLog`/signer validation.
- Witness proof `witnessedAt` handling.

## Steps

### Step 1: json.ts — make `created` optional
Replace the hard `created` check with: only validate when present, and only set
it on the reconstructed proof when it is a string.

- Remove the `if (typeof p.created !== 'string') throw ...` block.
- Add, after the required-field checks: `if (p.created !== undefined && typeof p.created !== 'string') throw new Error('Invalid proof: created must be a string');`
- Build `baseProof` without `created`, then conditionally add it:
  `if (typeof p.created === 'string') baseProof.created = p.created;`

### Step 2: cbor.ts — identical change
Apply the same edit to `cbor.ts`'s `parseProof`.

### Step 3: Regression tests
In both `json-serialization.test.ts` and `cbor-serialization.test.ts`, add a test
that builds an `EventLog` whose proof omits `created`, serializes it, re-parses it,
and asserts the round-trip succeeds and `created` is absent on the parsed proof.
Also add a test asserting a non-string `created` is still rejected.

These tests FAIL before the fix (parse throws) and PASS after.

## Done criteria (ALL must hold)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run build` succeeds
- [ ] A proof without `created` round-trips through JSON and CBOR
- [ ] A proof with a non-string `created` is still rejected by both parsers
- [ ] `bun run test` — SDK + auth suites 0 fail
- [ ] No out-of-scope files modified

## STOP conditions
- Some other code path actually depends on `created` always being present after
  parse (would surface as a failing existing test) — report rather than weaken.
