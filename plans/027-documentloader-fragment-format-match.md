# Plan 027: DocumentLoader must match verification methods across fragment-id format mismatches

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
- **Branch**: `correctness/round1-1` (from `origin/main`)
- **Target file**: `packages/sdk/src/vc/documentLoader.ts`

## Why this matters

`DocumentLoader.resolveDID` finds the verification method published in a
resolved DID document with an **exact** string comparison:

```ts
const vm = vms?.find((m) => m.id === didUrl);
```

This is incorrect because DID documents may publish verification methods with
**relative** fragment ids (e.g. `{ id: '#key-0' }`) while a credential proof's
`verificationMethod` references the **absolute** form
(`did:example:123#key-0`). Both forms are valid and equivalent per the DID Core
spec (a relative DID URL is resolved against the document's `id`/base). This
codebase actually emits relative ids: `did:peer` resolution and the webvh
relationships use `#key-0` (see `DIDManager.ts` `authentication: ['#key-0']`).

When the exact match fails, the loader:

1. Falls back to the global `verificationMethodRegistry` (line ~56), which an
   attacker who can call `registerVerificationMethod` could populate with a
   forged key under the same absolute id — re-opening the very forgery hole that
   Plan 024 closed, simply by relying on the format mismatch to bypass the DID
   document.
2. Or, if the registry has no entry, returns a stub
   `{ '@context', id }` with **no `publicKeyMultibase`** (line ~65), causing
   signature verification to fail spuriously for legitimate credentials.

Either way the cryptographic binding between proof and the issuer's published
key material is broken.

## The fix (minimal, correct)

In `resolveDID`, when a `fragment` is present, match the requested VM against
the DID document's `verificationMethod` array using a **format-tolerant**
comparison that treats relative (`#key-0`) and absolute
(`did:example:123#key-0`) ids as equivalent. Normalize both the requested id and
each candidate id to their canonical absolute form (resolve a leading-`#`
relative id against the resolved DID) before comparing.

The DID document remains authoritative: the registry is consulted only when the
DID document genuinely publishes no matching VM (preserving Plan 024). The
returned document keeps the **requested** `documentUrl`/`id` (so downstream
proof verification matching by id still works), but now carries the real
`publicKeyMultibase` from the published VM.

## In scope

- `packages/sdk/src/vc/documentLoader.ts` — add fragment-format-tolerant
  matching in `resolveDID`.
- `packages/sdk/tests/security/documentloader-fragment-format.test.ts` — new
  regression test (fails before, passes after).

## Regression test

A DID document publishes a verification method with a **relative** id
(`{ id: '#key-0', publicKeyMultibase: <real> }`). The loader is asked for the
**absolute** id (`<did>#key-0`). After the fix the returned document must carry
the DID document's real `publicKeyMultibase` and must NOT fall through to the
registry. A companion case: an attacker registers a forged VM under the absolute
id; the DID document's relative-id VM must still win.

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
