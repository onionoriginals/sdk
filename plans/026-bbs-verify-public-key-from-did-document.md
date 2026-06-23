# Plan 026: BBS cryptosuite must verify against the DID-document public key, not the proof-embedded key

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. Commit on the worktree branch (conventional
> commits). SKIP updating `plans/README.md` — the reviewer maintains the index.

## Status

- **Priority**: P0 (critical / key-substitution forgery)
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Planned at**: `origin/main` @ `b03e50d`, 2026-06-22

## Why this matters

`BBSCryptosuiteManager.verifyProof`
(`packages/sdk/src/vc/cryptosuites/bbsCryptosuite.ts`) extracts the public key
from the **proof itself** (`parsed.publicKey`, derived from the base proof
value) and passes it to `BbsSimple.verify(...)` as the verification key. The
subsequent DID-document check only validates that *some* verification-method key
on the resolved DID document is of type `Bls12381G2` — it never compares the
actual key bytes.

The proof is attacker-controlled data. A signature verifies against whatever
public key it is checked against, so an attacker who embeds their own
`Bls12381G2` public key in the base proof and signs with their own key produces
a proof that "verifies" — as long as the victim issuer's DID document happens to
contain any `Bls12381G2` verification method. This is a classic key-substitution
forgery: credentials can be forged under any issuer with a BLS key, without
possessing that issuer's signing key.

Today this is latent only because `BbsSimple.verify` throws `not implemented`,
so every BBS proof fails. The moment BBS+ verification is implemented this
becomes a critical forgery hole.

Contrast `EdDSACryptosuiteManager.verifyProof` (`eddsa.ts`, lines ~48-56) which
resolves the public key from the DID document via `documentLoader` and verifies
against *that* key. BBS must do the same.

## The rule

The public key used to verify a BBS proof MUST come from the resolved DID
document's verification method, not from the proof. The proof-embedded key (when
present) MUST equal the DID-document key, byte for byte; otherwise verification
fails closed.

## In scope (only these files)

- `packages/sdk/src/vc/cryptosuites/bbsCryptosuite.ts` — fix `verifyProof`.
- `packages/sdk/tests/unit/vc/cryptosuites/bbsCryptosuite.verifyProof.test.ts`
  — new regression test.

## Implementation

In `BBSCryptosuiteManager.verifyProof`:

1. Resolve the verification method via `options.documentLoader` (required for
   verification — mirror EdDSA, which calls `options.documentLoader` directly).
   If no `documentLoader` is provided, fail closed.
2. Decode `publicKeyMultibase` from the resolved verification method. It MUST be
   `Bls12381G2`; otherwise return `{ verified: false, errors: [...] }`.
3. Compare the DID-document key bytes against `parsed.publicKey` (the
   proof-embedded key). If they differ, return
   `{ verified: false, errors: ['Proof public key does not match verification method'] }`.
   This is the security fix: reject substitution before any signature check.
4. Pass the **DID-document key** (not `parsed.publicKey`) to `BbsSimple.verify`.

## Regression test

`bbsCryptosuite.verifyProof.test.ts`:

- Build a base proof value via `BBSCryptosuiteUtils.serializeBaseProofValue`
  embedding an attacker `Bls12381G2` public key.
- Provide a `documentLoader` that resolves the verification method to a
  *different* (victim) `Bls12381G2` `publicKeyMultibase`.
- Assert `verifyProof` returns `verified: false` with the
  "does not match" error — i.e. it rejects on the key mismatch BEFORE reaching
  `BbsSimple.verify` (which would otherwise throw `not implemented`). The error
  must NOT be `not implemented`.
- Add a second case where the embedded key DOES match the DID-document key:
  verification then proceeds to `BbsSimple.verify` and surfaces the
  `not implemented` error (proving the matched path reaches the signature check).

Before the fix the mismatch case fails: the old code never compares key bytes,
so it reaches `BbsSimple.verify` and returns the `not implemented` error instead
of the "does not match" error. After the fix it returns the mismatch error.

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
