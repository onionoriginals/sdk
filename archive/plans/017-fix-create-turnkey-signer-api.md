# Plan 017: Fix `createTurnkeySigner` signature mismatch (2 failing auth tests)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/auth/src/server/turnkey-signer.ts packages/auth/tests/turnkey-signer.test.ts`
> If these changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

`packages/auth` has 2 failing tests (137 pass / 2 fail) because the tests call
`createTurnkeySigner` with an options object while the implementation takes
five positional arguments. The object lands in the first positional slot
(`subOrgId`), every other field is `undefined`, and the constructed signer has
no verification method or public key. Anyone who copies the test-file calling
convention (the natural reference) gets a silently broken signer at runtime —
`getVerificationMethodId()` returns `undefined` and signing produces proofs
with no usable verification method. It also keeps the auth package's CI red,
which (together with plan 016) blocks the test gate from meaning anything.

## Current state

- `packages/auth/src/server/turnkey-signer.ts:155-169` — current implementation:

```typescript
export function createTurnkeySigner(
  subOrgId: string,
  keyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string,
  publicKeyMultibase: string
): TurnkeyWebVHSigner {
  return new TurnkeyWebVHSigner(
    subOrgId,
    keyId,
    publicKeyMultibase,
    turnkeyClient,
    verificationMethodId
  );
}
```

- `packages/auth/tests/turnkey-signer.test.ts:8-44` — tests call it with an
  object, and use **different field names** for the first two params:

```typescript
const signer = createTurnkeySigner({
  turnkeyClient: mockClient,
  organizationId: 'org_123',      // maps to subOrgId
  privateKeyId: 'key_456',        // maps to keyId
  verificationMethodId: 'did:key:z6MkTest#z6MkTest',
  publicKeyMultibase: 'z6MkTest',
});
```

  Failing: "signer returns correct verification method ID" (line 29) and
  "signer returns correct public key multibase" (line 42), both
  `Received: undefined`. The first test ("creates a TurnkeyWebVHSigner
  instance") passes only because `instanceof` doesn't inspect fields.

- `TurnkeyWebVHSigner` constructor (same file, ~line 30s; verified via the
  passing test at `turnkey-signer.test.ts:47-60`): positional
  `(subOrgId, keyId, publicKeyMultibase, turnkeyClient, verificationMethodId)`.
  Do not change it — its tests pass.

- Export surface: `packages/auth/src/server/index.ts:35` —
  `export { TurnkeyWebVHSigner, createTurnkeySigner } from './turnkey-signer';`.
  The package is published to npm (`@originals/auth` v1.9.x), so the
  positional form may have external callers.

## Commands you will need

| Purpose    | Command (from repo root)            | Expected on success |
|------------|--------------------------------------|---------------------|
| Auth tests | `cd packages/auth && bun test`       | 139 pass / 0 fail   |
| Typecheck  | `cd packages/auth && bunx tsc --noEmit -p . 2>/dev/null \|\| bunx tsc --noEmit src/index.ts` | exit 0 (check `packages/auth/package.json` for a `typecheck` script first and prefer it) |
| Repo-wide check | `cd packages/auth && grep -rn 'createTurnkeySigner' ../.. --include='*.ts' \| grep -v node_modules \| grep -v dist` | only signer source, its index export, tests, and possibly docs |

## Scope

**In scope**:
- `packages/auth/src/server/turnkey-signer.ts` (the `createTurnkeySigner`
  function only)
- `packages/auth/src/types.ts` (only if you put the options interface there —
  check where the package keeps shared types and match)
- `plans/README.md` (status row only)

**Out of scope**:
- `TurnkeyWebVHSigner` class — constructor and behavior stay as-is.
- The test file — it is the spec for the new call shape; do not edit.
- Any other auth module (`email-auth.ts` etc. — plan 018 owns those).

## Git workflow

- Branch: `advisor/017-fix-create-turnkey-signer-api`
- Conventional commit, e.g.
  `fix(auth): accept options object in createTurnkeySigner (back-compat with positional args)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the options-object form with a back-compat overload

Replace `createTurnkeySigner` with an overloaded function that accepts both
shapes (the package is published; don't break positional callers):

```typescript
export interface CreateTurnkeySignerOptions {
  turnkeyClient: Turnkey;
  organizationId: string;
  privateKeyId: string;
  verificationMethodId: string;
  publicKeyMultibase: string;
}

export function createTurnkeySigner(options: CreateTurnkeySignerOptions): TurnkeyWebVHSigner;
/** @deprecated Use the options-object form. */
export function createTurnkeySigner(
  subOrgId: string,
  keyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string,
  publicKeyMultibase: string
): TurnkeyWebVHSigner;
export function createTurnkeySigner(
  optionsOrSubOrgId: CreateTurnkeySignerOptions | string,
  keyId?: string,
  turnkeyClient?: Turnkey,
  verificationMethodId?: string,
  publicKeyMultibase?: string
): TurnkeyWebVHSigner {
  if (typeof optionsOrSubOrgId === 'string') {
    return new TurnkeyWebVHSigner(
      optionsOrSubOrgId, keyId!, publicKeyMultibase!, turnkeyClient!, verificationMethodId!
    );
  }
  const o = optionsOrSubOrgId;
  return new TurnkeyWebVHSigner(
    o.organizationId, o.privateKeyId, o.publicKeyMultibase, o.turnkeyClient, o.verificationMethodId
  );
}
```

Note the argument-order trap this fixes permanently: `TurnkeyWebVHSigner`
takes `publicKeyMultibase` THIRD and `verificationMethodId` FIFTH. Preserve the
existing mapping exactly (it is what the passing constructor test pins).

**Verify**: `cd packages/auth && bun test` → 139 pass / 0 fail

### Step 2: Check for internal positional callers

`grep -rn 'createTurnkeySigner(' packages/ --include='*.ts' | grep -v node_modules | grep -v dist | grep -v test`
— if any internal caller uses the positional form, migrate it to the options
form (the deprecation should only apply outward).

**Verify**: grep above shows internal callers (if any) using the object form;
`bun test` still 139/0.

## Test plan

The 2 failing tests are the regression tests; no new tests required. If you
want belt-and-braces, add one test asserting the deprecated positional form
still constructs an equivalent signer (same file, same describe block — but
note the test file is otherwise out of scope; only ADD, never modify existing
cases).

## Done criteria

ALL must hold:

- [ ] `cd packages/auth && bun test` → 139+ pass, **0 fail**
- [ ] Positional call form still type-checks (back-compat overload present)
- [ ] No changes to `TurnkeyWebVHSigner` or existing test cases (`git diff`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The live function signature differs from the excerpt (drift).
- More than the 2 listed tests fail in `packages/auth` before you start —
  baseline has moved; re-establish it first.
- You find published documentation (README/docs) teaching the positional form
  with DIFFERENT argument semantics than the implementation — that's a doc bug
  to report alongside, not to silently fix here.

## Maintenance notes

- The deprecated positional overload should be removed at the next major
  version of `@originals/auth`; leave a `TODO(@next-major)` comment on it.
- Reviewer should double-check the field mapping
  (`organizationId→subOrgId`, `privateKeyId→keyId`) against how
  `TurnkeyWebVHSigner` uses them internally for Turnkey API calls.
