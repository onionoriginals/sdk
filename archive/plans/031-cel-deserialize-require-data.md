# Plan 031: Require the `data` field in CEL JSON/CBOR deserialization (match the LogEntry type)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note it).
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Worktree branches from `origin/main` (`correctness/round1-5`). At the worktree root:
1. `bun install --frozen-lockfile || bun install`.
2. Baseline: `bunx tsc --noEmit` → exit 0; `bun run test` → existing suites pass.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: bug (type/serialization mismatch) / correctness
- **Planned at**: `origin/main` @ `ff6cfb1`, 2026-06-23

## Why this matters

`LogEntry.data` is declared **required** (`data: unknown`, no `?`) in
`packages/sdk/src/cel/types.ts:47`. The field carries the actual event payload
and is part of the hash-chain commitment (`canonicalizeEntryForChain` includes
it; `JSON.stringify` silently omits an `undefined` field, so a present-vs-absent
`data` produces different committed bytes).

But both deserialization parsers accept a `LogEntry` whose `data` key is
**absent**, blindly copying `e.data` (which is `undefined`) into the
reconstructed entry:
- `src/cel/serialization/json.ts:137-141` — `data: e.data` with no presence check.
- `src/cel/serialization/cbor.ts:88-92` — identical.

Consequences:
1. **Type-contract violation** — the parser returns a `LogEntry` with
   `data === undefined`, which the interface forbids. Downstream code that
   assumes a populated `data` fails with cryptic errors instead of a clear parse
   error at the boundary.
2. **Silent data loss** — a provider/API (or a corrupted file) can strip the
   `data` field in transit and the SDK accepts the log without complaint.

Every other required `LogEntry`/proof field (`type`, `proof`, proof `type`,
`cryptosuite`, `verificationMethod`, `proofPurpose`, `proofValue`) is validated
for presence; `data` is the lone gap. The existing tests in
`packages/sdk/tests/unit/cel/{json,cbor}-serialization.test.ts` always include an
explicit `data` field and never exercise the missing-`data` case.

Decision: require `data` to be **present** (the key must exist) in both parsers,
throwing a clear error when it is absent. Any value is allowed when present
(including `null`, `{}`, `0`, `false`) because the type is `unknown` and existing
tests round-trip empty objects and falsy payloads — only an entirely missing key
is rejected.

## Current state

`parseEntry` in both `json.ts` and `cbor.ts` is identical:

```typescript
const parsedEntry: LogEntry = {
  type: e.type,
  data: e.data,        // no check that the key is present
  proof: e.proof.map(parseProof),
};
```

## Scope

**In scope:**
- `packages/sdk/src/cel/serialization/json.ts` (`parseEntry`: require `data` present)
- `packages/sdk/src/cel/serialization/cbor.ts` (`parseEntry`: require `data` present)
- `packages/sdk/tests/unit/cel/json-serialization.test.ts` (regression test)
- `packages/sdk/tests/unit/cel/cbor-serialization.test.ts` (regression test)

**Out of scope:**
- Constraining the *value* of `data` beyond presence (it is `unknown`).
- Any other field's validation.
- `createEventLog`/signer validation.

## Steps

### Step 1: json.ts — require `data` present
In `parseEntry`, after the `proof`-array check and before constructing
`parsedEntry`, add a presence check:

```typescript
if (!('data' in e)) {
  throw new Error('Invalid entry: missing required data field');
}
```

Use `'data' in e` (not `e.data !== undefined`) so an explicit falsy/null payload
is preserved while a genuinely absent key is rejected.

### Step 2: cbor.ts — identical change
Apply the same presence check to `cbor.ts`'s `parseEntry`. (CBOR maps decode to
plain objects, so `'data' in e` works the same way.)

### Step 3: Regression tests
In both `json-serialization.test.ts` and `cbor-serialization.test.ts`, add:
- A test that builds a serialized log/entry with the `data` key removed and
  asserts the parser throws `Invalid entry: missing required data field`.
  - For JSON: stringify an events object whose entry has no `data` key.
  - For CBOR: encode (via the same `encode` util the parser's `decode` mirrors)
    an events object whose entry has no `data` key, then parse.
- A test confirming a present-but-falsy `data` (e.g. `null` or `{}`) still
  round-trips successfully (guards against using a truthiness check).

These tests FAIL before the fix (parse succeeds / returns `data: undefined`) and
PASS after.

## Done criteria (ALL must hold)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run build` succeeds
- [ ] An entry missing `data` is rejected by both JSON and CBOR parsers
- [ ] An entry with falsy `data` (`null`/`{}`) still round-trips through both
- [ ] `bun run test` — SDK + auth suites 0 fail
- [ ] No out-of-scope files modified

## STOP conditions
- An existing valid path relies on `data` being omittable after parse (would
  surface as a failing existing test) — report rather than weaken.
