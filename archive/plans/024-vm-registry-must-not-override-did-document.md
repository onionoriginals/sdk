# Plan 024: Verification-method registry must never override the resolved DID document (signature-forgery fix)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and
> report. Commit on the worktree branch. SKIP updating `plans/README.md` — the
> reviewer maintains the index.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Branch**: `correctness/round1-4` (from `origin/main`)
- **Target file**: `packages/sdk/src/vc/documentLoader.ts`

## Why this matters

`packages/sdk/src/vc/documentLoader.ts` exposes a module-level mutable
`verificationMethodRegistry` and an exported `registerVerificationMethod`.
During DID-fragment resolution (`resolveDID`), the loader consults this global
registry **first** and returns the registered verification method **in
preference to** the verification method published in the actual resolved DID
document:

```
if (fragment) {
  const cached = verificationMethodRegistry.get(didUrl);   // checked FIRST
  if (cached) { return { ...cached } }                     // overrides the DID doc
  const vm = didDocTyped.verificationMethod?.find(...);    // only reached if no override
  ...
}
```

This breaks the core security property of verifiable credentials: a credential
must only verify against the **issuer's own published key**. Any caller of the
exported `registerVerificationMethod` can register a fake key under a victim's
DID identifier and have `EdDSACryptosuiteManager.verifyProof` retrieve that
forged key, validating attacker-controlled signatures — even though the
victim's real DID document publishes a different key.

## The fix (minimal, correct)

Make the **resolved DID document authoritative**. The registry may only act as
a fallback for verification methods the DID document does not itself publish; it
must never override a verification method that the DID document does publish.

Concretely, in `resolveDID`, when a `fragment` is present:

1. First look for the requested VM in the resolved DID document's
   `verificationMethod` array. If found, return it (the DID document wins).
2. Only if the DID document does **not** publish that VM, fall back to the
   registry.
3. Otherwise, fall back to the existing stub `{ '@context', id }`.

This eliminates the override-forgery: a DID that publishes its key can no longer
be shadowed by a registered key. The registry remains usable only for DIDs whose
resolved document genuinely contains no matching verification method (the
existing test/flow fixtures whose `did:peer:*` stubs carry no inline VM).

## In scope

- `packages/sdk/src/vc/documentLoader.ts` — reorder precedence so the DID
  document is consulted before the registry; update the explanatory comment.
- `packages/sdk/tests/security/registry-no-override.test.ts` — new regression
  test (fails before, passes after).

## Regression test

A DID document publishes a real verification method (real public key). An
attacker registers a *different* (forged) public key under the **same** VM id
via `registerVerificationMethod`. After the fix, `loader('<did>#vm')` must
return the **DID document's** public key, not the forged one.

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
