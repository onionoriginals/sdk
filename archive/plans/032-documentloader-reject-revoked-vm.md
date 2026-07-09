# Plan 032: documentLoader must reject revoked / compromised verification methods

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and
> report. Commit on the worktree branch. SKIP updating `plans/README.md` — the
> reviewer maintains the index.

## Status

- **Priority**: P0 (high)
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Branch**: `correctness/round1-5` (from `origin/main`)
- **Target file**: `packages/sdk/src/vc/documentLoader.ts`

## Why this matters

`DocumentLoader.resolveDID()` loads a verification method (VM) from a DID
document (or the `verificationMethodRegistry` fallback) and returns it for VC
Data Integrity proof verification. The consumer
`EdDSACryptosuiteManager.verifyProof()` (`vc/cryptosuites/eddsa.ts`) reads
`vmDoc.document.publicKeyMultibase` and uses it to verify the proof.

The `VerificationMethod` type (`src/types/did.ts`) carries optional `revoked`
and `compromised` ISO-8601 timestamps. `KeyManager` sets these when keys are
rotated out (`revoked`) or recovered after compromise (`compromised`). A retired
VM is deliberately left in the DID document so verifiers can recognise it as
retired. However, the document loader spreads the matched VM verbatim into the
returned document and never consults these fields, and `verifyProof` never
checks them either. As a result a proof signed by a revoked/compromised key
resolves to a valid public key and verifies successfully — an attacker holding
the old private key could forge accepted credential signatures.

This mirrors the previously fixed CEL key-resolver issue (plan 025) and the
BBS/signWithKeyStore retired-VM issues (plans 026/030). The document loader is
the single chokepoint for VC proof key resolution, so the fix belongs here.

## The fix (minimal, correct)

In `resolveDID()`, after locating the matching VM (and likewise for the cached
registry VM fallback), fail closed by throwing when the VM carries a `revoked`
or `compromised` timestamp. `EdDSACryptosuiteManager.verifyProof()` already
wraps the loader call in try/catch and returns `{ verified: false }` on any
thrown error, so a retired key cleanly fails verification rather than leaking a
usable key.

Throwing (rather than returning a key-less stub) is preferred because a stub
would otherwise fall through to canonicalization with a missing key and could
produce a confusing/ambiguous failure; an explicit error names the cause.

## In scope

- `packages/sdk/src/vc/documentLoader.ts` — reject DID-document VMs and cached
  registry VMs that carry `revoked` or `compromised`; update JSDoc/comments.
- `packages/sdk/tests/unit/vc/documentLoader.test.ts` — new regression test
  (fails before, passes after): the loader returns the key for an active VM but
  throws when the same VM is revoked or compromised.

## Regression test

A DID document publishes an Ed25519 VM. The loader returns its
`publicKeyMultibase` when the VM is active (guards against over-rejection). When
the same VM carries a `revoked` (or `compromised`) timestamp, the loader must
reject (throw). Covers both the DID-document path and the registry-fallback
path.

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
