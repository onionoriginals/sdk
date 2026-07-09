# Plan 032: EdDSA verifyProof must reject revoked / compromised verification methods

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and
> report. Commit on the worktree branch. SKIP updating `plans/README.md` — the
> reviewer maintains the index.

## Status

- **Priority**: P0 (critical)
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Branch**: `correctness/round1-1-eddsa-revoke` (from `origin/main`)
- **Target file**: `packages/sdk/src/vc/cryptosuites/eddsa.ts`

## Why this matters

`EdDSACryptosuiteManager.verifyProof()` loads a verification method from the DID
document via `documentLoader(proof.verificationMethod)` and uses its
`publicKeyMultibase` to verify the signature. It never consults the VM's
`revoked` or `compromised` status before accepting the signature.

The `VerificationMethod` type (`src/types/did.ts`) carries optional `revoked`
and `compromised` ISO-8601 timestamps. `KeyManager.rotateKeys()` sets `revoked`
when a key is rotated out, and `KeyManager.recoverFromCompromise()` sets
`compromised`. Retired VMs remain published in the DID document precisely so
verifiers can recognise them as no longer valid signing keys. Because
`verifyProof()` ignores these fields, an attacker holding an old, revoked or
compromised private key can forge a credential signature that verifies
successfully — defeating the entire purpose of key rotation / compromise
recovery.

The CEL key resolver (`src/cel/keyResolver.ts`, plan 025) already fails closed
on `vm.revoked || vm.compromised`. The VC verification path must enforce the
same invariant. The document loader (`src/vc/documentLoader.ts`) spreads the
full matched VM (`...vm`) into the returned document, so the `revoked` /
`compromised` fields are present on `vmDoc.document` and can be checked directly.

## The fix (minimal, correct)

In `verifyProof()`, after loading the verification method document, fail closed
if the loaded VM carries a `revoked` or `compromised` timestamp — throw an error
(which the existing try/catch converts into `{ verified: false, errors: [...] }`)
before decoding the public key. This treats retired keys exactly like an invalid
key type.

## In scope

- `packages/sdk/src/vc/cryptosuites/eddsa.ts` — reject loaded VMs with `revoked`
  or `compromised` set, before public-key decode.
- `packages/sdk/tests/unit/vc/cryptosuites/eddsa.test.ts` — new regression tests
  (fail before, pass after).

## Regression test

Sign a credential with a valid Ed25519 key so the signature itself is valid.
Then verify it with a document loader that returns the same VM but additionally
marked `revoked` (and a second case `compromised`). `verifyProof()` must return
`verified: false`. A control case (same VM, no revoked/compromised) must still
return `verified: true`, guarding against over-rejection.

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
