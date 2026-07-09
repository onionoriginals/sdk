# Plan 013 (SPIKE): Design a unified `verify()` entry point

> **Executor instructions**: This is a DESIGN/SPIKE plan, not a build-everything
> plan. The deliverable is a written design doc plus a minimal proof-of-concept,
> NOT a finished feature. Timebox it. Honor STOP conditions. When done, update
> this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/verify packages/sdk/src/vc/Verifier.ts packages/sdk/src/cel`
> If these changed, account for it in the design.

## Status

- **Priority**: P3 (direction)
- **Effort**: M (spike; full build is larger)
- **Risk**: LOW (spike produces a doc + PoC, not shipped surface)
- **Depends on**: 001 (the unified verifier must inherit the fixed
  issuer-binding rules, not the forgeable legacy path)
- **Category**: direction
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

The repo has an empty `src/verify/` directory, while verification logic is
scattered across three places a consumer must know to choose between:
`vc/Verifier.ts` (W3C credentials), `cel/algorithms/verifyEventLog.ts` (CEL event
logs), and `did/BtcoDidResolver.ts` (did:btco resolution). There is no single
`verify(document)` entry point, even though all proof types are
`DataIntegrityProof` underneath and the empty directory signals the intent was
there. A unified verifier is architecturally cheap and would give the SDK one
obvious front door for "is this thing valid?". Because verification is
security-critical, this is scoped as a spike: design the dispatch and API, prove
it on two proof types, and surface the open questions — so the maintainer can
decide before committing to a public surface.

## Current state

- `packages/sdk/src/verify/` — exists, **empty** (confirm:
  `ls packages/sdk/src/verify`).
- `packages/sdk/src/vc/Verifier.ts` — `verifyCredential` / `verifyPresentation`
  for W3C VCs via `DataIntegrityProofManager`.
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` — CEL event-log
  verification (uses `eddsa-jcs-2022`).
- `packages/sdk/src/did/BtcoDidResolver.ts` — did:btco resolution/validation.
- After plan 001, `CredentialManager.verifyCredential` binds the verification key
  to the issuer DID — the unified verifier MUST reuse that, never the old legacy
  trust-the-embedded-key path.

**Convention to follow:** the SDK is organized by concern with a manager/facade
per area. A `UnifiedVerifier` belongs in `src/verify/` and should DELEGATE to the
existing verifiers, not reimplement them.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Confirm empty dir | `ls -la packages/sdk/src/verify` | empty (or note contents) |
| Locate verifiers | `grep -rln "verifyCredential\|verifyEventLog\|resolve" packages/sdk/src/vc packages/sdk/src/cel packages/sdk/src/did` | the three subsystems |
| PoC test | `cd packages/sdk && bun test tests/unit/verify/unified-verify.spike.test.ts` | passes |

## Scope

**In scope (spike deliverables):**
- A design doc: `plans/013-unified-verify-design.md` (write your findings there)
- A minimal PoC: `packages/sdk/src/verify/UnifiedVerifier.ts` (PoC quality —
  dispatches to the existing VC verifier and one other type)
- A PoC test: `packages/sdk/tests/unit/verify/unified-verify.spike.test.ts`

**Out of scope:**
- A production-complete, exported public API (that's a follow-up build plan once
  the design is approved).
- Changing the existing verifiers' behavior.
- Wiring `UnifiedVerifier` into `index.ts` exports (leave it internal until the
  design is accepted).

## Git workflow

- Branch: `advisor/013-spike-unified-verify`
- Conventional Commits, e.g. `spike(sdk): prototype unified verify() entry point`.
- No push/PR unless instructed.

## Steps

### Step 1: Inventory the verification surfaces

Read the three verifiers. For each, record: what input it takes, what proof type
/ cryptosuite it handles, what it returns, and how a caller currently selects it.
Write this into `plans/013-unified-verify-design.md`.

### Step 2: Define the dispatch contract

Propose a single `verify(document, options?)` signature that infers the document
kind (W3C VC vs CEL event log vs did:btco reference) from its shape/proof and
delegates. Specify:
- the discriminator (e.g. `type`, presence of `proof.cryptosuite`, CEL envelope
  markers),
- a unified `VerificationResult` shape,
- how the issuer-binding rules from plan 001 are inherited (the VC branch must go
  through the fixed `CredentialManager`/`Verifier`, never a key-from-proof path).
Document open questions (e.g. ambiguous documents, async DID resolution
requirements, where the `DIDManager` comes from).

### Step 3: Minimal PoC on two proof types

Implement `UnifiedVerifier` that dispatches to (a) the W3C VC verifier and (b)
one other (CEL event log OR did:btco). Keep it minimal — the goal is to prove the
dispatch works and the result shape is coherent, not to cover every case.

**Verify**: `cd packages/sdk && bun test tests/unit/verify/unified-verify.spike.test.ts`
→ passes (one VC document and one other-type document each route correctly).

### Step 4: Write the recommendation

In the design doc, conclude with: recommended API, what a full build would cost
(files touched, edge cases), risks, and an explicit "should we build this?"
recommendation for the maintainer.

## Test plan

- One spike test in `tests/unit/verify/unified-verify.spike.test.ts`:
  - a valid VC routes to the VC verifier and returns verified,
  - a tampered VC returns not-verified (proves it inherited the real verifier,
    not a stub),
  - one other document type routes correctly.
- Model after `tests/unit/vc/Verifier.test.ts`.
- Verification: `cd packages/sdk && bun test tests/unit/verify` → passes.

## Done criteria

ALL must hold:

- [ ] `plans/013-unified-verify-design.md` exists with inventory, dispatch
      contract, open questions, and a build/no-build recommendation
- [ ] `packages/sdk/src/verify/UnifiedVerifier.ts` PoC dispatches to ≥2 verifiers
- [ ] `cd packages/sdk && bun test tests/unit/verify/unified-verify.spike.test.ts` → passes (incl. tampered-VC negative case)
- [ ] The VC branch uses the post-001 issuer-bound verifier (no key-from-proof)
- [ ] `tsc` error count not increased vs baseline
- [ ] `plans/README.md` row updated

## STOP conditions

- Plan 001 has NOT landed — the unified verifier would inherit the forgeable
  path. STOP and do 001 first.
- The three verifiers have incompatible result/async models that can't be unified
  without changing them — document the conflict in the design doc and recommend
  against (or for, with the required changes) rather than forcing it.

## Maintenance notes

- This is a spike: its output is a decision, not a shipped feature. Do not export
  `UnifiedVerifier` from the package index until the design is approved.
- If approved, the follow-up build plan must: cover all proof types, add full
  test coverage, export the API, and document it in `docs/` and the README.
- Reviewer: focus on the design doc's risk analysis and whether the VC branch is
  genuinely issuer-bound (the whole point of not regressing plan 001).
