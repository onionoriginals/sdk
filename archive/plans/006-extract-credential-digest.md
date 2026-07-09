# Plan 006: Extract the duplicated credential digest into one shared helper

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/vc/CredentialManager.ts packages/sdk/src/vc/MultiSigManager.ts`
> If either changed, compare excerpts to live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 001 (CredentialManager's digest/verify is edited there; land 001 first to avoid a conflicting rewrite)
- **Category**: tech-debt
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

The exact same "canonicalize credential + canonicalize proof-without-value →
SHA-256 each → concatenate" digest is implemented twice: in
`CredentialManager.generateProofValue` (used by the legacy local signer and the
legacy verify path) and in `MultiSigManager.computeDigest`. Because they are
independent copies, a correctness or security fix to one silently fails to reach
the other — exactly the kind of drift that produces signatures that validate in
one manager but not the other. Consolidating into a single tested helper removes
that risk and gives the digest one place to be reviewed.

## Current state

- `packages/sdk/src/vc/CredentialManager.ts:415-439` — `generateProofValue`
  builds the digest then signs:
  ```ts
  const proofSansValue = { ...proofBase } as Record<string, unknown>;
  delete proofSansValue.proofValue;
  const proofInput: Record<string, unknown> = { ...proofSansValue };
  const credentialContext = credential['@context'];
  if (credentialContext && !proofInput['@context']) {
    proofInput['@context'] = credentialContext;
  }
  const unsignedCredential: Record<string, unknown> = { ...credential };
  delete unsignedCredential.proof;
  const c14nProof = await canonicalizeDocument(proofInput);
  const c14nCred = await canonicalizeDocument(unsignedCredential);
  const hProof = Buffer.from(sha256(Buffer.from(c14nProof, 'utf8')));
  const hCred = Buffer.from(sha256(Buffer.from(c14nCred, 'utf8')));
  const digest = Buffer.concat([hProof, hCred]);
  ```
  The legacy verify path in `verifyCredential` (`:313-327`) inlines the SAME
  computation a third time.
- `packages/sdk/src/vc/MultiSigManager.ts:537-561` — `computeDigest` is identical
  in logic (Uint8Array concat instead of Buffer.concat, same byte result):
  ```ts
  const proofSansValue = { ...proofBase } as Record<string, unknown>;
  delete proofSansValue.proofValue;
  const proofInput: Record<string, unknown> = { ...proofSansValue };
  const credentialContext = credential['@context'];
  if (credentialContext && !proofInput['@context']) {
    proofInput['@context'] = credentialContext;
  }
  const unsignedCredential: Record<string, unknown> = { ...credential };
  delete unsignedCredential.proof;
  const c14nProof = await canonicalizeDocument(proofInput);
  const c14nCred = await canonicalizeDocument(unsignedCredential);
  const hProof = sha256(Buffer.from(c14nProof, 'utf8'));
  const hCred = sha256(Buffer.from(c14nCred, 'utf8'));
  const digest = new Uint8Array(hProof.length + hCred.length);
  digest.set(hProof, 0); digest.set(hCred, hProof.length);
  ```

Both import `canonicalizeDocument` from `../utils/serialization` and `sha256`
from `@noble/hashes/sha2.js`.

**Convention to follow:** shared crypto/serialization helpers live in
`src/utils/`. Place the new helper there and have both managers import it.
**Byte-for-byte output must be preserved** — existing signatures must still
verify.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| VC tests | `cd packages/sdk && bun test tests/unit/vc` | all pass |
| Helper test | `cd packages/sdk && bun test tests/unit/utils/credential-digest.test.ts` | passes |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "CredentialManager\|MultiSigManager\|credential-digest"` | empty |
| Grep gate | `grep -c "canonicalizeDocument(proofInput)" packages/sdk/src/vc` (recursive) | reduced to 0 in the two managers |

## Scope

**In scope:**
- `packages/sdk/src/utils/credential-digest.ts` (create)
- `packages/sdk/src/vc/CredentialManager.ts` (call the helper in
  `generateProofValue` AND the legacy verify path)
- `packages/sdk/src/vc/MultiSigManager.ts` (call the helper in `computeDigest`)
- `packages/sdk/tests/unit/utils/credential-digest.test.ts` (create)

**Out of scope:**
- The Data Integrity (`eddsa-rdfc-2022`) path in `src/vc/cryptosuites/eddsa.ts` —
  that is a different, spec-defined digest; do NOT fold it in.
- Any change to what gets signed (the security model) — plan 001 owns that.

## Git workflow

- Branch: `advisor/006-extract-credential-digest`
- Conventional Commits, e.g. `refactor(sdk): extract shared credential digest helper`.
- No push/PR unless instructed.

## Steps

### Step 1: Snapshot current digest bytes (safety net)

Before refactoring, write `tests/unit/utils/credential-digest.test.ts` that
constructs a fixed credential + proofBase and asserts the digest equals a value
you capture from the CURRENT code. To capture it: temporarily log the digest hex
from `MultiSigManager.computeDigest` for a fixed input, or compute it inline in
the test by replicating the current logic, then assert the new helper matches.
The point: a golden value so the refactor can't change bytes silently.

### Step 2: Create the shared helper

`src/utils/credential-digest.ts`:

```ts
import { canonicalizeDocument } from './serialization';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Canonical digest used by the legacy (non-DataIntegrity) credential signer:
 * sha256(c14n(proof-without-proofValue)) || sha256(c14n(credential-without-proof)).
 * Byte-for-byte stable — changing this invalidates existing signatures.
 */
export async function computeCredentialDigest(
  credential: Record<string, unknown>,
  proofBase: Record<string, unknown>
): Promise<Uint8Array> {
  const proofInput: Record<string, unknown> = { ...proofBase };
  delete proofInput.proofValue;
  const ctx = (credential as any)['@context'];
  if (ctx && !proofInput['@context']) proofInput['@context'] = ctx;
  const unsigned: Record<string, unknown> = { ...credential };
  delete unsigned.proof;
  const c14nProof = await canonicalizeDocument(proofInput);
  const c14nCred = await canonicalizeDocument(unsigned);
  const hProof = sha256(Buffer.from(c14nProof, 'utf8'));
  const hCred = sha256(Buffer.from(c14nCred, 'utf8'));
  const out = new Uint8Array(hProof.length + hCred.length);
  out.set(hProof, 0); out.set(hCred, hProof.length);
  return out;
}
```

(Confirm the `publicKeyMultibase` deletion: plan 001 added
`delete proofSansValue.publicKeyMultibase` to the verify path. If 001 has
landed, include `delete proofInput.publicKeyMultibase;` here so verify still
matches sign. Check `CredentialManager.ts` for that line and mirror it.)

**Verify**: `cd packages/sdk && bun test tests/unit/utils/credential-digest.test.ts` → passes against the golden value.

### Step 3: Replace the three inlined copies

- `CredentialManager.generateProofValue`: replace the digest block with
  `const digest = Buffer.from(await computeCredentialDigest(credential as any, proofBase as any));`
- `CredentialManager.verifyCredential` (legacy path): replace its inlined digest
  with the same call.
- `MultiSigManager.computeDigest`: replace the body with
  `return computeCredentialDigest(credential as any, proofBase as any);`

**Verify**: `cd packages/sdk && bun test tests/unit/vc` → all pass (this proves
existing signatures still verify — same bytes).

### Step 4: Typecheck

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -E "CredentialManager|MultiSigManager|credential-digest"` → empty.

## Test plan

- New: `tests/unit/utils/credential-digest.test.ts` — golden-value test (Step 1),
  plus a test that context-injection happens (proof gets the credential's
  `@context` when missing).
- Existing: all of `tests/unit/vc` (CredentialManager, MultiSigManager,
  Verifier) must continue to pass unchanged — that is the real regression gate.
- Verification: `cd packages/sdk && bun test tests/unit/vc tests/unit/utils` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/unit/vc tests/unit/utils` → all pass
- [ ] `grep -rn "c14nProof = await canonicalizeDocument" packages/sdk/src/vc` → no matches (all routed through the helper)
- [ ] `grep -n "computeCredentialDigest" packages/sdk/src/vc/CredentialManager.ts packages/sdk/src/vc/MultiSigManager.ts` → present in both
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- The golden-value test shows the two managers produced DIFFERENT bytes for the
  same input before refactor (i.e. they were not actually identical) — STOP and
  report; consolidating would change one manager's signatures.
- Any `tests/unit/vc` test fails after Step 3 (means bytes changed) — revert and
  report.
- Plan 001 has not landed and the verify path still trusts `publicKeyMultibase` —
  coordinate ordering (001 first).

## Maintenance notes

- Reviewer: the only safety property that matters here is byte-stability — confirm
  via the golden test and the unchanged `tests/unit/vc` suite.
- This is the legacy digest. If the SDK fully migrates to Data Integrity proofs
  (the `eddsa-rdfc-2022` path), this helper and its callers can eventually be
  deleted — note that as the long-term direction.
