# Plan 022: Validate deserialized DID Documents and Verifiable Credentials

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> Commit on the worktree branch (conventional commit). SKIP updating
> `plans/README.md` — the reviewer maintains the index.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Branch**: `correctness/round1-3`

## Why this matters

`deserializeDIDDocument()` and `deserializeCredential()` in
`packages/sdk/src/utils/serialization.ts` parse JSON and then **cast** the result
directly to `DIDDocument` / `VerifiableCredential` with no runtime validation:

```typescript
const parsed: unknown = JSON.parse(data);
return parsed as DIDDocument;  // No validation!
```

Any malformed or malicious JSON that happens to be syntactically valid is
silently accepted as a typed object. Deserialized documents are reconstructed
from network/storage sources, so an attacker controlling that source
(compromised storage, MITM) can inject documents missing required fields, with
invalid DID formats, non-string values, or absent verification methods — all of
which downstream code trusts because the TypeScript type says it is valid.

The repo already has `validateDIDDocument()` and `validateCredential()` in
`packages/sdk/src/utils/validation.ts`, but they are never called in the
deserialization path. The fix is to wire them in.

## Current state

- `packages/sdk/src/utils/serialization.ts`
  - `deserializeDIDDocument(data)` (lines 52–60): `JSON.parse` then `as DIDDocument`.
  - `deserializeCredential(data)` (lines 67–75): `JSON.parse` then `as VerifiableCredential`.
  - Both wrap parse in try/catch throwing `Invalid DID Document JSON` /
    `Invalid Verifiable Credential JSON`.
- `packages/sdk/src/utils/validation.ts`
  - `validateDIDDocument(didDoc): boolean` — checks `@context` array, `id` is a
    valid DID, verification methods well-formed, controller entries valid DIDs.
  - `validateCredential(vc): boolean` — checks `@context` (with VC v1), `type`
    includes `VerifiableCredential`, valid DID issuer, ISO `issuanceDate`,
    `credentialSubject` present.
- `packages/sdk/tests/unit/utils/serialization.test.ts` — existing roundtrip +
  invalid-JSON tests. The roundtrip fixtures are already valid per the validators
  (DID doc has `@context` array + `did:peer:` id; VC has VC v1 context, type,
  DID issuer, issuanceDate, credentialSubject), so they keep passing.

## Scope

**In scope:**
- `packages/sdk/src/utils/serialization.ts` — call the validators after parsing;
  throw on validation failure.
- `packages/sdk/tests/unit/utils/serialization.test.ts` — add regression tests
  for structurally-invalid (but JSON-valid) input being rejected.

**Out of scope:**
- Changing the validator semantics in `validation.ts`.
- Changing error message strings for the existing invalid-JSON cases.

## Design decision

The validators expect typed inputs but only do structural/`typeof` checks, so
passing parsed `unknown` is safe. After a successful `JSON.parse`, run the
matching validator; if it returns `false`, throw the SAME error message already
used for the parse failure (`Invalid DID Document JSON` /
`Invalid Verifiable Credential JSON`). Reusing the message keeps the public
contract stable (callers/tests only assert that message) while closing the hole:
"invalid" now covers structurally invalid, not just syntactically invalid.

A non-object parse result (e.g. `JSON.parse('5')` → number, `'null'` → null)
must also be rejected; the validators already return `false` for these because
the `@context` check fails on a non-object, but guard explicitly for clarity.

## Steps

### Step 1: Add a failing regression test
In `serialization.test.ts`, add tests asserting structurally-invalid JSON is
rejected with the existing error messages:
- `deserializeDIDDocument('{}')` → throws `Invalid DID Document JSON` (no
  `@context`, no `id`).
- `deserializeDIDDocument('{"@context":["https://www.w3.org/ns/did/v1"],"id":"not-a-did"}')`
  → throws (invalid DID format).
- `deserializeCredential('{}')` → throws `Invalid Verifiable Credential JSON`.
- `deserializeCredential('{"@context":["https://www.w3.org/2018/credentials/v1"],"type":["VerifiableCredential"],"issuer":"not-a-did","issuanceDate":"2020-01-01T00:00:00Z","credentialSubject":{}}')`
  → throws (invalid issuer DID).
- `deserializeDIDDocument('5')` and `deserializeCredential('null')` → throw.

**Verify (must FAIL before the fix):**
`cd packages/sdk && NODE_OPTIONS= bun test tests/unit/utils/serialization.test.ts`

### Step 2: Wire validators into deserialization
In `serialization.ts`, import `validateDIDDocument` and `validateCredential`
from `./validation`. In each deserialize function, after parsing, run the
validator and throw the existing error message if it returns false. Keep the
try/catch for `JSON.parse`; do the validation outside the parse catch (or
re-throw) so a validation failure isn't masked into a generic message — but it
should produce the SAME message string. Implementation: parse inside try/catch
(throws on syntax error), then validate after and throw the same message.

**Verify:**
- `cd packages/sdk && NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0
- `cd packages/sdk && NODE_OPTIONS= bun test tests/unit/utils/serialization.test.ts` → all pass

### Step 3: Full invariant
- `bunx tsc --noEmit` → 0 errors
- `bun run build` → succeeds
- `bun run test` → SDK + auth suites 0-fail

## Done criteria (ALL must hold)
- [ ] Structurally invalid (but JSON-valid) DID docs / VCs are rejected.
- [ ] Existing roundtrip + invalid-JSON tests still pass (same error messages).
- [ ] `tsc --noEmit` 0 errors; `build` succeeds; full test suite 0-fail.
- [ ] Only in-scope files modified.

## STOP conditions
- An existing roundtrip fixture turns out to be invalid per the validators
  (would mean a real consumer relies on lax deserialization) — report instead of
  weakening a validator.
