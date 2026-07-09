# Plan 015: Make CEL proof verification cryptographically real (default + CLI)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/sdk/src/cel packages/sdk/src/utils/encoding.ts packages/sdk/src/crypto`
> Plan 014 is a *required* predecessor and will have changed
> `src/cel/algorithms/verifyEventLog.ts` — that change is expected. Verify
> plan 014's status is DONE in `plans/README.md`; if it is not, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/014-fix-cel-canonicalization.md
- **Category**: security
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

`verifyEventLog` — and therefore the `originals-cel verify` CLI command — does
**no cryptographic verification at all** unless the caller supplies a custom
verifier. The built-in `defaultVerifier` only checks that a proof has the right
fields and that `proofValue` starts with `z` or `u`
(`src/cel/algorithms/verifyEventLog.ts:66-101`). The CLI calls
`verifyEventLog(eventLog)` with no verifier (`src/cel/cli/verify.ts:222`) and
then prints "verified". A user can fabricate any proof with a plausible shape
and the tool reports the provenance log as verified. For an SDK whose purpose
is *cryptographically verifiable provenance*, this is the gap between the
promise and the implementation.

The fix is cheap because everything needed already exists: CLI-created proofs
use `verificationMethod: did:key:<multikey>#<multikey>` (the public key is
embedded in the identifier), the repo has multikey decoding and
`@noble/ed25519`, and plan 014 made the signing serialization canonical.

## Current state

Relevant files (all under `packages/sdk/`):

- `src/cel/algorithms/verifyEventLog.ts` — `defaultVerifier` (structural only,
  lines 66–101); `verifyEvent` builds the signed payload as
  `eventData = { type, data, ...(previousEvent ? { previousEvent } : {}) }`
  (lines ~182–186) and calls `verifier(proof, eventData)`.
- `src/cel/cli/verify.ts` — `verifyCommand` calls `verifyEventLog(eventLog)`
  with no options (line 222).
- `src/cel/cli/create.ts` — `createSigner` (~lines 139–160) shows the proof
  format the verifier must match: Ed25519 over the canonicalized event base,
  `cryptosuite: 'eddsa-jcs-2022'`,
  `verificationMethod: \`did:key:${publicKey}#${publicKey}\`` where
  `publicKey` is a multikey-encoded Ed25519 public key, and
  `proofValue = multikey.encodeMultibase(signature)`.
- `src/cel/canonicalize.ts` — created by plan 014; `canonicalizeEvent(data)`
  returns the exact bytes the signer signed.
- Multikey utilities: the CLI imports a `multikey` helper (see the import block
  at the top of `src/cel/cli/create.ts`) providing `decodePublicKey`,
  `encodeMultibase` and a decode counterpart. `src/crypto/Multikey.ts` also
  exists. Use whichever the CLI signers use, for symmetry.
- `src/did/Ed25519Verifier.ts` — existing Ed25519 verify wrapper
  (`verifyAsync(signature, message, publicKey)` with 32/33-byte key handling).
  You may reuse it or call `verifyAsync` from `@noble/ed25519` directly.
- `src/cel/types.ts` — `VerifyOptions` (accepts a custom `verifier`),
  `VerificationResult`, `EventVerification`, `DataIntegrityProof`.

Current `defaultVerifier` shape (will be extended, not deleted —
`verifyEventLog.ts:66-101`):

```typescript
async function defaultVerifier(proof: DataIntegrityProof, data: unknown): Promise<boolean> {
  // ...field checks only...
  // Validate proofValue is properly formatted (multibase encoded)
  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) {
    return false;
  }
  return true;
}
```

Repo conventions:

- `@noble/ed25519` is imported dynamically in CLI code
  (`await import('@noble/ed25519')`) but statically in `src/did/Ed25519Verifier.ts`
  (`import { verifyAsync } from '@noble/ed25519'`). Static import is fine in
  `src/cel/algorithms/`.
- Tests: `bun:test`, under `packages/sdk/tests/unit/cel/`.

## Commands you will need

| Purpose   | Command (from repo root)                       | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p .`     | exit 0              |
| CEL tests | `cd packages/sdk && bun test cel`               | all pass            |
| Unit tests| `cd packages/sdk && bun test tests/unit`        | no NEW failures (16 pre-existing in DIDCache/Metrics/StatusList) |

## Scope

**In scope**:
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
- `packages/sdk/src/cel/cli/verify.ts`
- `packages/sdk/src/cel/types.ts` (only if a result flag is added — see Step 3)
- `packages/sdk/src/cel/index.ts` (export new verifier if useful)
- `packages/sdk/tests/unit/cel/proof-verification.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope**:
- The VC subsystem (`src/vc/**`) and its `eddsa-rdfc-2022` verification — a
  separate, already-hardened path (issuer-bound since commit 392dc17).
- did:webvh / did:btco resolution of verification methods. **Only `did:key`
  verification methods get cryptographic verification in this plan.** Resolving
  other DID methods to keys requires network access and belongs to a future
  plan (the unified verify() work).
- `src/cel/canonicalize.ts` — consume it, don't change it.

## Git workflow

- Branch: `advisor/015-cel-cryptographic-verification`
- Conventional commits, e.g.
  `feat(sdk): cryptographically verify did:key eddsa-jcs-2022 proofs in CEL verification`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Implement the did:key Ed25519 proof verifier

In `verifyEventLog.ts`, add (and export) a function:

```typescript
export async function verifyDidKeyEd25519Proof(
  proof: DataIntegrityProof,
  data: unknown
): Promise<boolean>
```

Behavior:
1. Run the existing structural checks (reuse the current `defaultVerifier`
   logic as a precondition).
2. Parse `proof.verificationMethod`. Expected form
   `did:key:<multikey>#<fragment>`; extract `<multikey>` (the part between
   `did:key:` and `#`). If it doesn't start with `did:key:`, return the result
   of the structural check only — i.e. fall back to legacy behavior (see Step 3
   for how the caller distinguishes these).
3. Decode the multikey to raw Ed25519 public key bytes using the same multikey
   helper the CLI signer uses (find the import in `src/cel/cli/create.ts` and
   mirror its `decodePublicKey` usage; verify it strips the multicodec prefix —
   write the round-trip test in Step 4 before relying on it).
4. Decode `proof.proofValue` from multibase to raw signature bytes (the decode
   counterpart of `multikey.encodeMultibase`).
5. Compute `message = canonicalizeEvent(data)` (import from `../canonicalize`).
6. Return `verifyAsync(signature, message, publicKey)` from `@noble/ed25519`.
   Wrap in try/catch returning `false` on any decode/verify error.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p .` → exit 0

### Step 2: Make it the default for did:key proofs

In `verifyEventLog`'s options handling (where `options.verifier ?? defaultVerifier`
is chosen, near line 258 pre-plan-014): when no custom verifier is supplied,
use a default that dispatches:

- `verificationMethod` starts with `did:key:` AND
  `cryptosuite === 'eddsa-jcs-2022'` → `verifyDidKeyEd25519Proof` (full crypto).
- anything else → existing structural checks, **and** record a warning (Step 3).

A caller-supplied `options.verifier` continues to override everything
(existing behavior, do not break it — several tests pass custom verifiers).

**Verify**: `cd packages/sdk && bun test cel` → pre-existing CEL tests still
pass. (If an existing test created structurally-valid-but-fake did:key proofs
and expected `verified: true`, it will now fail — that is the vulnerability
being closed. Update such tests to sign properly with a real key, using the
test pattern from Step 4.)

### Step 3: Surface "structural only" honestly

Add to each `EventVerification` (in `src/cel/types.ts`) an optional field:

```typescript
/** False when the proof could only be structurally validated (no crypto). */
cryptographicallyVerified?: boolean;
```

Set it `true` when `verifyDidKeyEd25519Proof` ran, `false` when only the
structural path ran. In `src/cel/cli/verify.ts`'s output function, print a
clearly visible warning line when any event has
`cryptographicallyVerified === false`, e.g.
`⚠ proof structure checked only — signature NOT cryptographically verified`.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p .` → exit 0

### Step 4: Tests

Create `packages/sdk/tests/unit/cel/proof-verification.test.ts`:

1. **Round-trip**: generate a real Ed25519 keypair (mirror the keygen in
   `src/cel/cli/create.ts` — `ed25519.utils` + multikey encode), build a signer
   exactly like `createSigner` in `create.ts` (sign
   `canonicalizeEvent(eventBase)`), create a log via `createEventLog`, append
   via `updateEventLog`, then `verifyEventLog(log)` →
   `verified: true` and every event `cryptographicallyVerified: true`.
2. **Tampered data**: flip a nested field in the last event's `data`, re-verify
   → that event's proof verification fails (`verified: false`).
3. **Tampered signature**: corrupt one character mid-`proofValue`, re-verify →
   fails.
4. **Wrong key**: re-sign event with key A but set `verificationMethod` to key
   B's did:key → fails (this asserts the key actually comes from the
   verificationMethod, i.e. binding).
5. **Non-did:key VM**: a proof with `verificationMethod: 'did:webvh:example#k1'`
   → structural path, `cryptographicallyVerified: false`, no throw.

**Verify**: `cd packages/sdk && bun test tests/unit/cel/proof-verification.test.ts` → all pass

### Step 5: Full suite

**Verify**: `cd packages/sdk && bun test tests/unit && bun test tests/integration`
→ no failures beyond the 16 pre-existing (DIDCache/Metrics/StatusList).
If `tests/integration/cel-lifecycle.test.ts` used fake-proof stub signers and
asserted `verified: true`, update those stubs to real Ed25519 signing (the
Step 4 helper) rather than weakening the verifier.

## Test plan

See Step 4 — five named cases, file
`tests/unit/cel/proof-verification.test.ts`, modeled structurally on
`tests/integration/cel-lifecycle.test.ts`.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bunx tsc --noEmit -p .` exits 0
- [ ] `bun test cel` exits 0
- [ ] New test proves: valid sign→verify round-trip passes; tampered
      data/signature/wrong-key all fail
- [ ] `originals-cel verify` path (i.e. `verifyCommand`) performs crypto
      verification for did:key proofs (covered by a test or by tracing that
      `verifyEventLog`'s new default is used — no extra flag needed)
- [ ] Structural-only verification is flagged, not silent
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Plan 014 is not DONE (this plan signs/verifies `canonicalizeEvent` bytes).
- The multikey helper used by the CLI cannot decode the keys it encodes
  (round-trip test in Step 4 fails at the decode step) — that's a deeper
  encoding bug to report, not patch around.
- Existing tests rely on fabricated proofs passing verification in ways that
  look intentional (e.g. a documented "structural mode") — surface the
  conflict instead of choosing.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This intentionally covers only `did:key` + `eddsa-jcs-2022`. The unified
  `verify()` work (see `plans/013-unified-verify-design.md`) is the natural
  home for resolving did:webvh/did:btco verification methods via
  `DIDManager.resolveDID` and feeding them into this verifier — deferred.
- Reviewer should scrutinize: the signed-payload shape (`{type, data,
  previousEvent?}`) must match between signer (`createSigner` in the CLI) and
  verifier (`verifyEvent`'s `eventData`) — the first-event case (no
  `previousEvent` key) is the easy place for a mismatch.
- `WitnessService`/`HttpWitness` proofs (if they produce non-did:key VMs) will
  flow down the structural path and be flagged — expected, revisit when
  witnesses get their own verification story.
