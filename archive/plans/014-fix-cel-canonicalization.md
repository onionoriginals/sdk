# Plan 014: Fix CEL canonicalization so hashes and signatures cover all event content

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/sdk/src/cel`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

The CEL (Cryptographic Event Log) subsystem is the provenance backbone of this
SDK, and its canonicalization is broken in a way that defeats its security
guarantees. Five sites serialize events with
`JSON.stringify(value, Object.keys(value).sort())`. When the second argument
to `JSON.stringify` is an **array**, it acts as a property **allowlist applied
at every nesting level** — any nested key not coincidentally named `type`,
`data`, `previousEvent`, or `proof` is silently dropped. Concretely:

- The hash chain (`previousEvent`) only covers the *shape* of prior events,
  not their content. **Nested fields of a past event can be tampered with and
  the chain still verifies.** Even `proofValue` inside the `proof` array is
  dropped from the hash input.
- The CLI signers sign this same gutted serialization, so signatures do not
  bind the event's actual data.
- A sixth site (the CLI `transfer` command) uses a *third*, incompatible
  serialization (unsorted, unfiltered) **and** a different multibase encoding,
  so any log that went through `originals-cel transfer` fails chain
  verification outright.

This plan consolidates all event serialization onto one correct JCS-style
canonicalizer and adds the tamper-detection tests that would have caught this.

## Current state

Relevant files (all under `packages/sdk/`):

- `src/cel/algorithms/updateEventLog.ts` — appends update events; computes the
  chain hash with the broken serializer (lines 20–24, used at line 66).
- `src/cel/algorithms/deactivateEventLog.ts` — same broken `serializeEntry`
  (lines 20–24, used at line 70).
- `src/cel/algorithms/verifyEventLog.ts` — contains BOTH a correct recursive
  canonicalizer `serializeToJcs` (lines 27–39) and the broken `serializeEntry`
  (lines 49–53, used in `verifyChain` at line ~137).
- `src/cel/cli/create.ts` — CLI signer serializes signing input with the broken
  pattern (line 145).
- `src/cel/cli/migrate.ts` — same (line 205).
- `src/cel/cli/transfer.ts` — signer same pattern (line 130); previous-event
  hash uses unsorted JSON + a different encoding (lines 236–240).
- `src/cel/hash.ts` — `computeDigestMultibase(content)` = sha256 + multibase
  base64url-nopad (`u` prefix). This is the canonical digest function; keep it.

The broken pattern (in `updateEventLog.ts:20-24`, `deactivateEventLog.ts:20-24`,
`verifyEventLog.ts:49-53`):

```typescript
function serializeEntry(entry: LogEntry): Uint8Array {
  // Use JSON with sorted keys for deterministic serialization
  const json = JSON.stringify(entry, Object.keys(entry).sort());
  return new TextEncoder().encode(json);
}
```

The correct pattern, already present at `verifyEventLog.ts:27-39`:

```typescript
function serializeToJcs(data: unknown): Uint8Array {
  // JCS uses JSON with lexicographically sorted keys
  const json = JSON.stringify(data, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = value[key];
        return sorted;
      }, {});
    }
    return value;
  });
  return new TextEncoder().encode(json);
}
```

The CLI signer pattern (`create.ts:145`, `migrate.ts:205`, `transfer.ts:130`):

```typescript
const dataStr = JSON.stringify(data, Object.keys(data as object).sort());
```

The CLI transfer chain-hash divergence (`transfer.ts:236-240`):

```typescript
const lastEvent = eventLog.events[eventLog.events.length - 1];
const lastEventStr = JSON.stringify(lastEvent);
const { sha256 } = await import('@noble/hashes/sha2.js');
const hashBytes = sha256(new TextEncoder().encode(lastEventStr));
const previousEvent = multikey.encodeMultibase(hashBytes);
```

(`multikey.encodeMultibase` is base58btc `z`-prefixed; `computeDigestMultibase`
is base64url `u`-prefixed — both the bytes AND the encoding differ from what
`verifyEventLog` recomputes.)

Repo conventions that apply:

- Imports within `src/cel` are relative (`import { computeDigestMultibase } from '../hash';`). Match that.
- Noble hashes are imported as `@noble/hashes/sha2.js` (with `.js`), never `@noble/hashes/sha256`.
- Unit tests live in `packages/sdk/tests/unit/`, run with `bun test`. Use
  `describe`/`test`/`expect` from `bun:test`. For structure, model on
  `packages/sdk/tests/unit/` neighbors (e.g. any existing `tests/unit/cel/`
  file if present, else `tests/integration/cel-lifecycle.test.ts`).

## Commands you will need

| Purpose   | Command (run from repo root)                                  | Expected on success |
|-----------|---------------------------------------------------------------|---------------------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p .`                    | exit 0              |
| CEL tests | `cd packages/sdk && bun test cel`                              | all pass            |
| Full unit | `cd packages/sdk && bun test tests/unit`                       | no NEW failures (16 pre-existing failures exist in DIDCache/Metrics/StatusList suites — those are not yours) |

## Scope

**In scope** (the only files you should modify/create):
- `packages/sdk/src/cel/canonicalize.ts` (create)
- `packages/sdk/src/cel/algorithms/updateEventLog.ts`
- `packages/sdk/src/cel/algorithms/deactivateEventLog.ts`
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
- `packages/sdk/src/cel/cli/create.ts`
- `packages/sdk/src/cel/cli/migrate.ts`
- `packages/sdk/src/cel/cli/transfer.ts`
- `packages/sdk/src/cel/index.ts` (export the new helper)
- `packages/sdk/tests/unit/cel/canonicalize.test.ts` (create)
- `packages/sdk/tests/unit/cel/hash-chain-tamper.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):
- `src/cel/hash.ts` — `computeDigestMultibase` is correct; reuse it as-is.
- `src/cel/serialization/json.ts` and `cbor.ts` — these serialize whole logs
  for file I/O, not for hashing/signing. Different concern.
- The VC subsystem (`src/vc/**`) — it uses `eddsa-rdfc-2022` with its own
  RDF canonicalization. Unrelated.
- The `defaultVerifier` in `verifyEventLog.ts` (structural-only verification)
  — making verification cryptographically real is plan 015. Do not start it here.

## Git workflow

- Branch: `advisor/014-fix-cel-canonicalization`
- Conventional commits, matching repo style, e.g.
  `fix(sdk): canonicalize CEL events with recursive JCS before hashing/signing`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the shared canonicalizer

Create `packages/sdk/src/cel/canonicalize.ts` exporting:

```typescript
/**
 * Canonicalizes a value to JCS-style JSON (lexicographically sorted keys at
 * every nesting level) and returns UTF-8 bytes. This is the single
 * serialization used for CEL event hashing and signing.
 */
export function canonicalizeEvent(data: unknown): Uint8Array
```

Implementation: the recursive-replacer pattern from `verifyEventLog.ts:27-39`
(copy it verbatim into the new file). Add a JSDoc warning that
`JSON.stringify(x, Object.keys(x).sort())` is NOT equivalent (array replacers
filter nested keys) — this comment is the constraint that prevents the bug
from coming back.

Export it from `packages/sdk/src/cel/index.ts` alongside the existing exports.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p .` → exit 0

### Step 2: Unit-test the canonicalizer

Create `packages/sdk/tests/unit/cel/canonicalize.test.ts` covering:

1. Nested object keys are preserved (regression for the allowlist bug):
   `canonicalizeEvent({ type: 'create', data: { name: 'x', nested: { b: 1, a: 2 } } })`
   decodes to a JSON string containing `"name"`, `"nested"`, `"a"`, `"b"`.
2. Keys sorted at every level: the decoded string equals
   `{"data":{"name":"x","nested":{"a":2,"b":1}},"type":"create"}`.
3. Arrays preserved in order, with objects inside arrays also key-sorted.
4. Demonstrative negative: the OLD pattern
   `JSON.stringify(input, Object.keys(input).sort())` on the same input does
   NOT contain `"name"` — proving the two are not equivalent.

**Verify**: `cd packages/sdk && bun test tests/unit/cel/canonicalize.test.ts` → all pass

### Step 3: Switch the algorithms to the shared canonicalizer

In `updateEventLog.ts`, `deactivateEventLog.ts`, and `verifyEventLog.ts`:

- Delete the local `serializeEntry` functions (and `serializeToJcs` in
  `verifyEventLog.ts`).
- Import `canonicalizeEvent` from `../canonicalize` and use it everywhere the
  deleted functions were used: chain-hash computation
  (`computeDigestMultibase(canonicalizeEvent(lastEvent))`) and, in
  `verifyEventLog.ts`, wherever `serializeToJcs` was referenced.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p .` → exit 0, and
`grep -rn "Object.keys(entry).sort()" packages/sdk/src/cel/` → no matches

### Step 4: Fix the CLI signers

In `create.ts` (~line 145), `migrate.ts` (~line 205), `transfer.ts` (~line 130),
replace:

```typescript
const dataStr = JSON.stringify(data, Object.keys(data as object).sort());
const dataBytes = new TextEncoder().encode(dataStr);
```

with:

```typescript
const dataBytes = canonicalizeEvent(data);
```

(import `canonicalizeEvent` — note the CLI files are one directory deeper, so
`../canonicalize`.)

**Verify**: `grep -rn "Object.keys(data as object).sort()" packages/sdk/src/cel/` → no matches

### Step 5: Fix the CLI transfer chain hash

In `transfer.ts` (~lines 236–240), replace the unsorted-JSON + base58 hash with
the same computation `updateEventLog` uses:

```typescript
const lastEvent = eventLog.events[eventLog.events.length - 1];
const previousEvent = computeDigestMultibase(canonicalizeEvent(lastEvent));
```

(import `computeDigestMultibase` from `../hash`). Remove the now-unused dynamic
`sha256` import if nothing else uses it.

**Verify**: `cd packages/sdk && bun test cel` → all pass

### Step 6: Add the tamper-detection regression test

Create `packages/sdk/tests/unit/cel/hash-chain-tamper.test.ts`:

1. Build a log with `createEventLog` (data containing nested objects, e.g.
   `{ name: 'asset', resources: [{ id: 'r1', digestMultibase: 'uAbc' }] }`),
   then `updateEventLog` twice. Use a stub signer (model the one in
   `packages/sdk/tests/integration/cel-lifecycle.test.ts:35-58`).
2. `verifyEventLog(log)` → `verified: true` (chain valid).
3. Tamper a NESTED field of event 0 (e.g. change
   `log.events[0].data.resources[0].digestMultibase`), re-verify →
   the result must report the chain broken for event 1
   (`chainValid: false` / error containing "Hash chain broken").
   **This is the exact tampering the old code failed to detect.**
4. Tamper `proofValue` of event 0's proof, re-verify → chain broken for event 1.

**Verify**: `cd packages/sdk && bun test tests/unit/cel/hash-chain-tamper.test.ts` → all pass

### Step 7: Full-suite check + fixture sweep

Run the CEL-related suites and search for stale precomputed hashes:

- `grep -rln "previousEvent" packages/sdk/tests/fixtures/ 2>/dev/null` — if any
  fixture file embeds precomputed `previousEvent` hashes from the old
  serialization, regenerate those fixtures with the new code (and say so in
  the commit message). If fixtures are hand-blessed artifacts you cannot
  regenerate, that's a STOP condition.

**Verify**: `cd packages/sdk && bun test tests/unit && bun test tests/integration`
→ no failures other than the 16 pre-existing ones in
`DIDCache`/`Metrics Integration`/`StatusListManager` suites.

## Test plan

Covered by steps 2 and 6. Net-new files:
- `tests/unit/cel/canonicalize.test.ts` (≥4 cases listed in step 2)
- `tests/unit/cel/hash-chain-tamper.test.ts` (≥3 cases listed in step 6)

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bunx tsc --noEmit -p .` exits 0
- [ ] `grep -rn "Object.keys(.*).sort())" packages/sdk/src/cel/` returns no
      matches that are passed as a `JSON.stringify` replacer
- [ ] `cd packages/sdk && bun test cel` exits 0
- [ ] New tamper test proves nested-data tampering breaks the chain
- [ ] `bun test tests/unit` shows no new failures vs. the 16 pre-existing
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift).
- Any committed fixture, doc example, or downstream test embeds precomputed
  CEL `previousEvent` hashes or `proofValue`s that cannot be regenerated —
  changing canonicalization invalidates them, and whether to version the
  serialization (e.g. a `celVersion` field) is a maintainer decision.
- You find a *published* consumer contract (e.g. docs promising stability of
  existing log hashes across SDK versions).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Logs created before this fix will fail chain verification after it.** This
  is intentional: the old hashes did not actually bind content. Add a
  CHANGELOG entry stating that CEL logs must be re-created (or re-hashed) with
  ≥ this version. If real user logs exist in the wild, the maintainer may want
  a one-shot `originals-cel rehash` migration command — explicitly deferred.
- Plan 015 (real cryptographic proof verification) builds directly on
  `canonicalizeEvent`; land this first.
- Reviewer should scrutinize: that *every* hash/sign site now goes through
  `canonicalizeEvent` (grep for `JSON.stringify` under `src/cel/` — remaining
  hits should only be file-output serialization in `cli/*.ts` and
  `serialization/*.ts`).
