# Plan 024: Issuer.issueCredential must bind the issuer DID to the signing verification method (fail closed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. Commit on the worktree branch (conventional
> commits). SKIP updating `plans/README.md` — the reviewer maintains the index.

## Status

- **Priority**: P0 (critical)
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Planned at**: `origin/main` @ `eccee62`, 2026-06-22

## Why this matters

`Issuer.issueCredential` (`packages/sdk/src/vc/Issuer.ts`, lines ~60-92)
extracts `issuerId` from the caller-supplied unsigned credential and uses it
directly as the credential's `issuer` value, falling back to
`this.verificationMethod.controller` only when no issuer is present:

```ts
const issuerId = typeof unsigned.issuer === 'string'
  ? unsigned.issuer
  : (unsigned.issuer as { id?: string })?.id;
const credential = {
  ...unsigned,
  '@context': withSecuringContext(unsigned['@context']),
  issuer: issuerId || this.verificationMethod.controller
};
```

There is **no validation** that `issuerId` matches the DID that actually owns
the signing key (`this.verificationMethod.controller`, which equals the DID
prefix of `this.verificationMethod.id`). This decouples the issuer claim from
the key that signs the credential: an attacker holding issuer A's private key
can call `issueCredential` with `issuer: B` and obtain a credential that claims
to be issued by B while being signed by A's key.

`CredentialManager.verifyCredential` already rejects this binding mismatch at
verification time (`resolveVerificationMethodMultibase` returns `null` when the
verification method's DID differs from the issuer DID). But issuance is the
fail-closed boundary: any code that serializes/stores the unsigned-then-signed
credential before verifying it would persist a malformed credential. Issuance
must refuse to mint a credential whose issuer does not own the signing key.

## The binding rule

A credential's `issuer` DID must equal the DID that controls the verification
method used to sign it. The controlling DID is:

- `this.verificationMethod.controller`, and
- the substring of `this.verificationMethod.id` before the `#` fragment.

When the caller supplies an `issuer` (string or `{ id }`), its DID must match
that controlling DID. When the caller omits the issuer, we default to the
controller (existing safe behavior).

## In scope (only these files)

- `packages/sdk/src/vc/Issuer.ts` — add the binding check in `issueCredential`.
- `packages/sdk/tests/unit/vc/Issuer.test.ts` — add a regression test.

## Implementation

1. In `issueCredential`, after computing `issuerId`, derive the controlling DID
   for the verification method. Prefer `this.verificationMethod.controller`;
   also compute the DID prefix of `this.verificationMethod.id` (the part before
   `#`) as the authoritative owner of the key.
2. If `issuerId` is present and does not equal the controlling DID, throw a
   clear error (e.g. `Issuer DID does not match verification method controller`).
   This is fail-closed: do not silently rewrite the issuer.
3. If `issuerId` is absent, keep defaulting to the controller (unchanged).

## Regression test

Add a test to `Issuer.test.ts` that constructs an Issuer whose verification
method is controlled by issuer A, then calls `issueCredential` with an unsigned
credential claiming `issuer: B`, and asserts it rejects. Also assert the
matching-issuer case still succeeds (covered by existing tests).

This test FAILS before the fix (the mismatched credential is happily signed and
returned) and PASSES after.

## Verification (run in the worktree)

```bash
cd /Users/brian/Projects/onionoriginals/sdk
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```

## STOP conditions

- If `bunx tsc --noEmit` reports new errors, stop and report.
- If any previously-passing test regresses, stop and report.
