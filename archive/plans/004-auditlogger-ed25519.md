# Plan 004: Implement Ed25519 signing in AuditLogger and re-enable migration auditing

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the expected result. Honor STOP conditions. When done, update this
> plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/migration/audit/AuditLogger.ts packages/sdk/src/migration/MigrationManager.ts packages/sdk/tests/unit/migration/audit/AuditLogger.test.ts`
> If any changed, compare excerpts to live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (independent of 001/003, but easier to verify once 003 makes the suite compile)
- **Category**: security / bug
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

Migration audit records claim to be tamper-evident and signer-authenticated, but
`AuditLogger` only computes a SHA-256 hash of the record and "verifies" by
recomputing that hash. There is no key involved, so a record re-hashed by ANY
party verifies as valid — the test "should fail verification with wrong public
key" expects `false` but gets `true`. The signer-based API the tests exercise
(`AuditSignerConfig`, a second constructor argument) doesn't exist. Separately,
`MigrationManager` has the AuditLogger entirely commented out ("temporarily
disabled for v1.0"), so layer transitions — including the security-critical move
to `did:btco` ownership — are unaudited. After this plan, AuditLogger supports
real Ed25519 signatures with key-bound verification, keeps the keyless SHA-256
mode as an explicit fallback, and MigrationManager records signed audit entries
for migrations.

## Current state

- `packages/sdk/src/migration/audit/AuditLogger.ts` — constructor takes only
  `config`; `signAuditRecord` (`:92-102`) hashes with SHA-256 and encodes via
  `encodeBase64UrlMultibase`; `verifyAuditRecord` (`:107-114`) recomputes the
  hash and compares. No key, no `AuditSignerConfig` type.
- `packages/sdk/tests/unit/migration/audit/AuditLogger.test.ts` — the contract.
  It imports `AuditSignerConfig` (`:3`), builds a signer config
  `{ privateKey, publicKey, verificationMethod }` (`:47-51`) from
  `@noble/ed25519`, and constructs `new AuditLogger(makeConfig(), signerConfig)`.
  Key assertions:
  - keyless mode: `signature.startsWith('z')` (`:65`) — **base58btc**, not the
    current base64url (`'u'`) encoding. So the keyless path must also switch to
    `'z'`/base58btc.
  - Ed25519 mode: `signature.startsWith('z')` (`:103`), verify true (`:113`),
    tampered record verifies false (`:124-126`), and a logger with a DIFFERENT
    key verifies the original record false (`:147-148`).
- `packages/sdk/src/migration/MigrationManager.ts` — AuditLogger import and all
  calls commented out; TODO markers at lines `24, 26, 39-40, 44, 69-70, 222,
  301-302, 471, 520`.
- Encoding helpers: `packages/sdk/src/utils/encoding.ts` has
  `encodeBase64UrlMultibase` (prefix `'u'`) AND a `multibase` object with
  `encode(val, 'base58btc')` producing the `'z'` prefix. Use the base58btc path
  for the new signatures.
- Ed25519 signer: `packages/sdk/src/crypto/Signer.ts` exports `Ed25519Signer`
  with `sign(data: Buffer, privateKeyMultibase: string)` and
  `verify(data, signature, publicKeyMultibase)`. But the test supplies RAW
  `Uint8Array` keys (`ed25519.utils.randomPrivateKey()`), not multibase — so
  either convert raw→multibase via `src/crypto/Multikey.ts` (`multikey.encodePrivateKey(key, 'Ed25519')`)
  or call `@noble/ed25519` directly. Reading `Multikey.ts` first is recommended.

**Convention to follow:** other crypto in this repo uses `@noble/ed25519` and
multibase via `src/crypto/Multikey.ts`. The CredentialManager Data Integrity
path (`src/vc/cryptosuites/eddsa.ts`) shows the canonical raw-key Ed25519
sign/verify with `@noble/ed25519` — mirror that.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Audit tests | `cd packages/sdk && bun test tests/unit/migration/audit/AuditLogger.test.ts` | all pass |
| Migration tests | `cd packages/sdk && bun test tests/unit/migration` | all pass |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "AuditLogger\|MigrationManager"` | empty |

## Scope

**In scope:**
- `packages/sdk/src/migration/audit/AuditLogger.ts`
- `packages/sdk/src/migration/MigrationManager.ts`
- `packages/sdk/tests/unit/migration/audit/AuditLogger.test.ts` (only if a test
  assertion needs adjusting to a correct shape — prefer NOT to change it; it is
  the spec)

**Out of scope:**
- The MigrationManager state machine / validation pipeline logic — only wire the
  audit calls back in; don't refactor migration flow.
- CredentialManager / VC signing.

## Git workflow

- Branch: `advisor/004-auditlogger-ed25519`
- Conventional Commits, e.g. `feat(sdk): sign migration audit records with Ed25519`.
- No push/PR unless instructed.

## Steps

### Step 1: Confirm the test contract compiles and currently fails

`cd packages/sdk && bun test tests/unit/migration/audit/AuditLogger.test.ts`.
Expect failures including "should fail verification with wrong public key"
(gets `true`) and likely the `startsWith('z')` assertions (current encoding is
`'u'`). Note exactly which fail — that's your target list.

### Step 2: Add the `AuditSignerConfig` type and optional constructor arg

In `AuditLogger.ts`, export:

```ts
export interface AuditSignerConfig {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  verificationMethod: string;
}
```

Change the constructor to `constructor(private config: OriginalsConfig, private signerConfig?: AuditSignerConfig)`.

### Step 3: Sign with Ed25519 when a signer is configured, SHA-256 otherwise

Rewrite `signAuditRecord` to branch on `this.signerConfig`:

- Build the canonical bytes the same way for both modes: strip `signature`,
  `JSON.stringify(recordWithoutSig)` (keep the existing canonicalization so the
  keyless tests still pass).
- If `signerConfig`: `signature = ed25519.sign(canonicalBytes, signerConfig.privateKey)`
  (use `@noble/ed25519`; it may be async — `signAsync` — match how
  `eddsa.ts` calls it). Encode with base58btc (`'z'` prefix) via
  `multibase.encode(sig, 'base58btc')` from `src/utils/encoding.ts`.
- Else (keyless): SHA-256 the canonical bytes as today, but encode with
  **base58btc** (`'z'`) so `startsWith('z')` holds. (Change the encoder from
  `encodeBase64UrlMultibase` to the base58btc multibase encode.)

Rewrite `verifyAuditRecord`:

- Strip `signature` and recompute canonical bytes.
- If `signerConfig`: decode the record's `signature` from base58btc and
  `ed25519.verify(sig, canonicalBytes, this.signerConfig.publicKey)`. Return the
  boolean. (A different logger's `publicKey` → verify returns false, satisfying
  the wrong-key test.)
- Else (keyless): recompute the SHA-256 base58btc signature and compare equality
  (as today, but with the new encoding).

**Verify**: `cd packages/sdk && bun test tests/unit/migration/audit/AuditLogger.test.ts`
→ all pass (both describe blocks: keyless and Ed25519).

### Step 4: Re-enable AuditLogger in MigrationManager

Un-comment the AuditLogger integration in `MigrationManager.ts` (the TODO sites).
Specifically:
- restore the import (`:26`),
- restore the private field and its construction in the constructor (`:39-40,
  69-70`) — pass through an `AuditSignerConfig` if the MigrationManager config
  provides signer material; otherwise construct keyless,
- restore the `logMigration(...)` call on successful migration (`:222, 471`),
- restore the history accessor to return signed records (`:301-302`).

Keep the change minimal — wire the calls exactly where the TODOs indicate; do
not alter migration control flow.

**Verify**: `cd packages/sdk && bun test tests/unit/migration` → all pass.

### Step 5: Typecheck

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "AuditLogger\|MigrationManager"` → empty.

## Test plan

- The existing `AuditLogger.test.ts` is the primary spec — make all of its cases
  pass without weakening assertions.
- Add one MigrationManager-level test (or extend an existing migration test) that
  performs a migration with a signer configured and asserts a **signed** audit
  record is retrievable and verifies true; model after existing tests in
  `tests/unit/migration/`.
- Verification: `cd packages/sdk && bun test tests/unit/migration` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/unit/migration/audit/AuditLogger.test.ts` → all pass (incl. wrong-public-key test)
- [ ] `cd packages/sdk && bun test tests/unit/migration` → all pass
- [ ] `grep -n "AuditLogger temporarily disabled" packages/sdk/src/migration/MigrationManager.ts` → no matches
- [ ] `grep -n "export interface AuditSignerConfig" packages/sdk/src/migration/audit/AuditLogger.ts` → found
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- Re-enabling AuditLogger in MigrationManager requires changing migration control
  flow or breaks unrelated migration tests — report; wiring should be additive.
- The MigrationManager config has no obvious place to source signer keys — then
  wire keyless mode and report that signed migration auditing needs a config
  surface for signer material (a small follow-up).
- The `AuditLogger.test.ts` assertions cannot be satisfied without changing them
  — re-read; the contract is intentional. Only change a test if it is provably
  wrong, and report why.

## Maintenance notes

- Reviewer: confirm the wrong-key test genuinely uses Ed25519 verification (not
  hash comparison) — the whole point is key binding.
- Follow-up (out of scope): make signed migration auditing mandatory for
  `did:btco` transitions, and persist signed records via the storage adapter
  (the `persistAuditRecord` path already exists).
- The keyless SHA-256 mode is integrity-only (anyone can recompute it). Document
  it as such wherever AuditLogger is configured.
