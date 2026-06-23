# Plan 030: signWithKeyStore must not select a revoked / compromised verification method

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
- **Branch**: `correctness/round1-0-vmselect` (from `origin/main`)
- **Target file**: `packages/sdk/src/lifecycle/LifecycleManager.ts`

## Why this matters

`LifecycleManager.signWithKeyStore()` (issuing migration / provenance
credentials) selects the verification method to sign with. When no key matches
the common patterns (`#key-0`, `#keys-1`, `#authentication`) and no keyStore VM
id prefixed by the issuer is found, it falls back to resolving the issuer's DID
document and **blindly picks `verificationMethod[0]`** (lines ~805-820).

The `VerificationMethod` type (`src/types/did.ts`) carries optional `revoked`
and `compromised` ISO-8601 timestamps. `KeyManager.rotateKeys()` /
`recoverFromCompromise()` stamp the OLD keys with those fields and build the
document as `[...retiredVerificationMethods, newActiveVerificationMethod]` —
i.e. after any rotation or compromise recovery, the **retired key sits at index
0 and the current active key is last**.

So after a single rotation, `verificationMethod[0]` is exactly the revoked /
compromised key. Signing a credential with it means the provenance chain is
anchored to a retired (possibly attacker-held) key, breaking integrity and
permitting forgery with a key that was deliberately retired. The same blind
"first match" defect exists in the keyStore prefix-scan fallback (it returns the
first stored id that starts with the issuer DID, with no revocation check).

This mirrors the fix already shipped for the CEL key resolver in plan 025
(`src/cel/keyResolver.ts` fails closed on `revoked || compromised`).

## The fix (minimal, correct)

Make verification-method selection in `signWithKeyStore` revocation-aware:

1. Resolve the issuer DID document up front so the retirement status of each
   candidate VM is known.
2. Treat a verification method as usable only if its DID-document entry is
   **active** (no `revoked` and no `compromised` timestamp). VM ids not present
   in the document (e.g. legacy keys only in the keyStore) remain usable —
   only an explicit retirement disqualifies a key.
3. When falling back to the DID document, select the **first active**
   verification method instead of `verificationMethod[0]`. If every VM is
   retired, fail closed with a clear `INVALID_DID_DOCUMENT` error rather than
   signing with a retired key.

Keep the common-pattern and prefix-scan fast paths, but gate each candidate
through the active-VM check before accepting it.

## In scope

- `packages/sdk/src/lifecycle/LifecycleManager.ts` — revocation-aware VM
  selection in `signWithKeyStore`.
- `packages/sdk/tests/unit/lifecycle/LifecycleManager.keymanagement.test.ts` —
  new regression test (fails before, passes after).

## Regression test

Construct a DID document with two Ed25519 verification methods where index 0 is
`revoked` (and a second variant where index 0 is `compromised`) and index 1 is
active. Store ONLY the active key in the keyStore under its full VM id, and stub
`didManager.resolveDID` to return that document. Sign via the publish path and
assert the resulting proof's `verificationMethod` is the active (index-1) VM,
never the retired index-0 one. Add a guard asserting the single-active-VM case
still signs correctly (no over-rejection).

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
