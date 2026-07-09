# Plan 028: CredentialManager VM fallback must use two-stage (exact + fragment) matching

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. Commit on the worktree branch (conventional
> commits). SKIP updating `plans/README.md` — the reviewer maintains the index.

## Status

- **Priority**: P0 (critical / legitimate credentials fail verification)
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness
- **Planned at**: `origin/main` @ `f1f45ec`, 2026-06-23

## Why this matters

`CredentialManager.resolveVerificationMethodMultibase`
(`packages/sdk/src/vc/CredentialManager.ts`) has a fallback path used when the
`documentLoader` does not resolve the proof's `verificationMethod`. That
fallback resolves the issuer DID document and searches its `verificationMethod`
array for the key:

```ts
const vm = vms.find((m) => m?.id === verificationMethod);
```

This is an **exact string match**. When a DID document publishes a verification
method with a *relative* id (e.g. `#keys-1`) while the proof references the
*absolute* form (`did:webvh:...#keys-1`) — or vice versa — the lookup fails and
a legitimate credential signed with a *published* key is rejected.

The CEL verification path already solves exactly this with **two-stage
matching** in `packages/sdk/src/cel/keyResolver.ts`:

```ts
const vm =
  vms.find(v => v.id === verificationMethod) ??
  vms.find(v => v.id.split('#')[1] === verificationMethod.split('#')[1]);
```

The two code paths (CEL event logs vs VC credentials) disagree on which key
authorizes a signature. A credential that verifies through the CEL path can fail
through the VC path. This inconsistency breaks the invariant that all code paths
agree on key authorization, and rejects valid credentials.

## The fix

In `resolveVerificationMethodMultibase`, replace the exact-only fallback match
with the same two-stage match used by the CEL key resolver: try exact id match
first, then fall back to fragment match. The fragment fallback is only reached
after the issuer-binding check (`verificationMethod.split('#')[0] !== issuerDid`
returns null earlier), so the key still must belong to the issuer's resolved DID
document — no trust is widened.

### In scope

- `packages/sdk/src/vc/CredentialManager.ts` — fallback VM lookup only.
- `packages/sdk/tests/unit/vc/CredentialManager.helpers.test.ts` — regression
  test (or a new focused test file).

## Regression test

Add a test that drives `verifyCredential` (or the resolver directly) with a DID
document whose published verification method uses a relative id while the proof
references the absolute id, and assert the credential verifies. The test must
fail before the fix (exact match misses) and pass after.

## Verification commands

```
cd /Users/brian/Projects/onionoriginals/sdk
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```
