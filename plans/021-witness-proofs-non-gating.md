# Plan 021: Make witness proofs non-gating in CEL verification (controller proof gates `verified`; witnesses checked + reported separately)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note
> it). SKIP updating `plans/README.md` — the reviewer maintains the index.
> If any `tsc`/`bun` command errors with `Cannot find module '.../cmux-claude-node-options/restore-node-options.cjs'`, re-run it prefixed with `NODE_OPTIONS=` (stale env preload, not a real failure).

## Worktree setup (REQUIRED FIRST)

Your worktree branches from `main`. The target state is plan 020's commit
`08087b2` (already in this repo's object store). At the worktree root:
1. `git fetch origin` then `git merge --no-verify --no-edit 08087b2` — fast-forwards onto the 020 state (clean; `main` is an ancestor).
2. `git log --oneline -1` should show `feat(sdk): cryptographically verify all CEL proofs via DID resolution...` (`08087b2`). `ls packages/sdk/src/cel/keyResolver.ts` must exist.
3. `bun install`.
4. Baseline: `cd packages/sdk && NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0; `NODE_OPTIONS= bun test tests/unit/cel` → all pass.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 020 (provided by setup).
- **Category**: bug (regression introduced by 020) / security-semantics
- **Planned at**: PR-branch state `08087b2`, 2026-06-19

## Why this matters

Plan 020 made CEL verification cryptographically check **every** proof and fail
closed otherwise — correct for the controller (author) proof. But a `LogEntry`'s
`proof` array holds **both** the controller proof **and** any third-party
**witness** attestations (`types.ts:51`: `proof: (DataIntegrityProof | WitnessProof)[]`),
and `verifyEvent` requires *all* of them to verify (`allProofsValid` is AND-ed).

Consequence: **attaching a witness to an otherwise-valid log now makes the whole
log `verified: false`** whenever that witness's DID can't be resolved — and
witnesses use `did:web` (which `DIDManager.resolveDID` doesn't support) and
`did:btco:witness` (the `BitcoinWitness` default). So adding a witness, or a
witness service being briefly offline, breaks the author's verification. That's
backwards: witnesses should *add* trust, not let a third party's availability
invalidate the controller's signature.

Decision (maintainer): **witness proofs are non-gating.** `verified` reflects the
controller proof(s); witness proofs are still cryptographically verified when
resolvable and reported separately, but a failed/unresolvable witness does NOT
make the log unverified.

## Current state

All under `packages/sdk/`:

- `src/cel/types.ts`
  - `WitnessProof` (~line 16) extends `DataIntegrityProof` with `witnessedAt: string`.
  - `LogEntry.proof: (DataIntegrityProof | WitnessProof)[]` (~line 51).
  - `EventVerification` (~lines 68–87): has `proofValid`, `chainValid`,
    `cryptographicallyVerified?`, `errors`. **Add a `witnessProofs?` field here.**
- `src/cel/serialization/cbor.ts:15` — existing discriminator:
  `isWitnessProof(p) => 'witnessedAt' in p && typeof p.witnessedAt === 'string'`.
  Controller proofs never set `witnessedAt` (confirmed: `createSigner`/
  `createEventLog` don't). Use this same test.
- `src/cel/algorithms/verifyEventLog.ts`
  - `dispatchVerify(proof, data, resolveKey?)` — verifies one proof, returns
    `{ verified, cryptographicallyVerified }`. **Do not change its per-proof logic.**
  - `verifyEvent(event, index, customVerifier, previousEvent, resolveKey)` — loops
    `event.proof`, AND-s `allProofsValid` across **all** proofs (controller +
    witness). This loop is what must change: gate on controller proofs only.
  - The signed payload is `eventData = { type, data, ...(previousEvent ? { previousEvent } : {}) }`.
- `src/cel/cli/verify.ts` — prints per-proof/verification output; currently a
  witness failure makes the log fail.

## Commands you will need

| Purpose | Command (worktree root; prefix `NODE_OPTIONS=` if a preload error appears) | Expected |
|---|---|---|
| Typecheck | `cd packages/sdk && NODE_OPTIONS= bunx tsc --noEmit -p .` | exit 0 |
| CLI verify tests | `cd packages/sdk && NODE_OPTIONS= bun test tests/unit/cel/cli-verify.test.ts` | all pass |
| Proof tests | `cd packages/sdk && NODE_OPTIONS= bun test tests/unit/cel/proof-verification.test.ts tests/unit/cel/verifyEventLog.test.ts` | all pass |
| Full suite | `cd packages/sdk && NODE_OPTIONS= bun test tests/integration tests/unit tests/security` | 0 fail (known `MetricsIntegration` "createDIDPeer totalTime>0" sub-ms flake excepted — rerun once) |

## Scope

**In scope:**
- `packages/sdk/src/cel/types.ts` (add `witnessProofs?` to `EventVerification`)
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (controller/witness split in `verifyEvent`)
- `packages/sdk/src/cel/cli/verify.ts` (report witness status; don't fail the log on witness failure)
- `packages/sdk/tests/unit/cel/cli-verify.test.ts` (revert the witness expectation; add witness-status assertions)
- `packages/sdk/tests/unit/cel/verifyEventLog.test.ts` and/or `proof-verification.test.ts` (add witness non-gating tests)

**Out of scope:**
- `dispatchVerify` per-proof logic, `keyResolver.ts`, `structuralCheck`, the
  resolver wiring (020 — keep as-is).
- Adding `did:web` resolution (a separate, declined option).
- `WitnessProof` shape, witness *creation* code (`src/cel/witnesses/**`).

## Steps

### Step 1: Add `witnessProofs` to `EventVerification`
In `src/cel/types.ts`, add to `EventVerification`:

```typescript
/**
 * Per-witness verification results. Witness proofs are cryptographically
 * checked when resolvable but are NON-GATING: a failed or unresolvable witness
 * does not affect `proofValid` / the log's overall `verified`. Empty/absent
 * when the event carries no witness proofs.
 */
witnessProofs?: { verificationMethod: string; verified: boolean }[];
```
**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 2: Split controller vs witness in `verifyEvent`
In `verifyEventLog.ts`, add a local discriminator mirroring `cbor.ts:15`:

```typescript
function isWitnessProof(p: DataIntegrityProof): boolean {
  return 'witnessedAt' in p && typeof (p as { witnessedAt?: unknown }).witnessedAt === 'string';
}
```

Rewrite the proof loop in `verifyEvent` so that:
- **Controller proofs** (NOT `isWitnessProof`): verified exactly as today (custom
  verifier if supplied, else `dispatchVerify`). They gate `allProofsValid` and
  contribute to `cryptographicallyVerified`. **Require at least one controller
  proof**: if an event has zero controller proofs, set `proofValid = false` and
  push an error `Event ${index}: no controller proof` (a witness-only event is
  not validly authored).
- **Witness proofs** (`isWitnessProof`): verified with the same mechanism
  (custom verifier if supplied, else `dispatchVerify` with `resolveKey`), but the
  result is recorded into a `witnessProofs` array `{ verificationMethod, verified }`
  and does **NOT** affect `allProofsValid` or `cryptographicallyVerified`. Do not
  push hard errors for witness failures (optionally push an informational note,
  but it must not change `proofValid`).

Set `witnessProofs` on the returned `EventVerification` (omit or `[]` when none).
Keep `proofValid` = (≥1 controller proof) AND (all controller proofs verified).
`cryptographicallyVerified` continues to reflect controller proofs only.

**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 3: CLI output
In `src/cel/cli/verify.ts`, ensure a witness failure no longer makes the command
report the log as failed. Print witness status separately, e.g. a line per
witness like `witness <vm>: verified | unverified (could not resolve)`. The
overall `verified` shown must follow the controller-gated result.
**Verify:** `NODE_OPTIONS= bun test tests/unit/cel/cli-verify.test.ts` → all pass.

### Step 4: Tests
- `cli-verify.test.ts` — the witness-attestation test that 020 changed to expect
  `verified: false`: **revert it to expect `verified: true`** (controller proof is
  a real did:key, valid offline) AND assert the witness is reported as unverified
  (e.g. `result.result?.events[0].witnessProofs` contains an entry with
  `verified: false` for the `did:web` witness). Update the test name to reflect
  "witness non-gating".
- Add a focused unit test (in `verifyEventLog.test.ts` or `proof-verification.test.ts`):
  1. Log with a valid `did:key` controller proof + a witness proof whose VM can't
     be resolved (no resolver) → `result.verified === true`,
     `events[0].witnessProofs[0].verified === false`.
  2. Same controller + a witness proof signed by a real Ed25519 key, with a mock
     `resolveKey` returning that key → `result.verified === true`,
     `events[0].witnessProofs[0].verified === true`.
  3. Event with ONLY a witness proof and no controller proof → `verified === false`
     (no controller proof).
- Keep all existing controller-path tests passing (a bad *controller* proof must
  still fail the log).

**Verify:** `NODE_OPTIONS= bun test tests/unit/cel/proof-verification.test.ts tests/unit/cel/verifyEventLog.test.ts tests/unit/cel/cli-verify.test.ts` → all pass.

### Step 5: Full suite
**Verify:** `NODE_OPTIONS= bun test tests/integration tests/unit tests/security` → 0 fail (known flake excepted — rerun once).

## Done criteria (ALL must hold)
- [ ] `NODE_OPTIONS= bunx tsc --noEmit -p .` exits 0
- [ ] A valid did:key controller proof + an unresolvable witness proof → `verified: true`, with the witness reported `verified: false` in `witnessProofs`
- [ ] A bad/unresolvable **controller** proof still → `verified: false` (gating unchanged for controller)
- [ ] An event with no controller proof → `verified: false`
- [ ] A resolvable, correctly-signed witness → `witnessProofs[].verified === true`
- [ ] Full suite 0 fail (known flake excepted)
- [ ] No out-of-scope files modified

## STOP conditions
- The setup merge conflicts (pre-verified clean — a conflict means drift).
- `isWitnessProof` cannot reliably distinguish controller from witness proofs in
  practice (e.g. a controller proof is found carrying `witnessedAt`) — report.
- Making witnesses non-gating breaks an unrelated test whose intent genuinely
  requires witness gating — report rather than weakening controller gating.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes
- After this: `verified` = "the controller validly authored every event + chain
  intact"; `witnessProofs` tells you which third-party attestations checked out.
  Consumers wanting "fully witnessed" can inspect `witnessProofs`.
- `did:web` witnesses still won't cryptographically verify (resolver lacks
  did:web support) — they'll show `verified: false` in `witnessProofs` without
  breaking the log. Adding did:web support is a separate, declined-for-now option.
- Reviewer should confirm a *controller* proof failure still fails the log (the
  020 guarantee must be intact) and that the witness split keys off `witnessedAt`.
