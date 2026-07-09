# 022 — CEL canonicalization for the hash chain (verification of prior fix)

## Finding (as reported)

[critical] Broken JSON serialization in `updateEventLog` hash chain computation.

> The `serializeEntry()` function uses `JSON.stringify(entry, Object.keys(entry).sort())`.
> When the second argument to `JSON.stringify` is an array it acts as a property
> *allowlist* applied at **every** nesting level — any key not present in the
> top-level key list is silently dropped from nested objects. As a result nested
> `data` fields, resource metadata, and even `proofValue` inside the `proof` array
> are omitted from the hash input. An attacker can mutate those nested fields after
> the `previousEvent` hash was computed and verification still passes, defeating the
> immutability guarantee of the provenance chain.

## Investigation result

This defect has **already been remediated on `origin/main`** (the base of this
worktree, at commit `0b8cd11`, audit PR #170). The broken
`JSON.stringify(entry, Object.keys(entry).sort())` array-replacer pattern no longer
exists in any CEL algorithm.

Specifically:

- A single canonicalization helper was introduced at
  `packages/sdk/src/cel/canonicalize.ts` exporting `canonicalizeEvent(data)`. It uses
  the **replacer-function** form of `JSON.stringify`, which recurses into every nested
  object and sorts keys at every depth without dropping any field (JCS-style). Its
  doc comment explicitly documents the array-replacer footgun and warns against it.
- All event algorithms compute the chain link via `canonicalizeEvent`:
  - `algorithms/updateEventLog.ts` → `computeDigestMultibase(canonicalizeEvent(lastEvent))`
  - `algorithms/deactivateEventLog.ts` → same
  - `algorithms/verifyEventLog.ts` → uses `canonicalizeEvent` both for the expected
    previous-event hash and for proof message bytes
  - CLI paths (`cli/create.ts`, `cli/transfer.ts`, `cli/migrate.ts`) likewise use it
- `algorithms/witnessEvent.ts` uses the equivalent correct recursive replacer-function
  form inline, so it was never vulnerable.

## Regression coverage (already present)

`packages/sdk/tests/unit/cel/hash-chain-tamper.test.ts` already covers exactly the
finding's scenarios:

1. tampering a **nested** field of event 0's `data` breaks the chain at event 1
2. tampering `proofValue` inside event 0's `proof` array breaks the chain
3. tampering the top-level `name` field breaks the chain
4. a valid log verifies as a baseline

Plus `packages/sdk/tests/unit/cel/canonicalize.test.ts` directly tests the serializer.

## Verification performed (fails-before / passes-after)

To prove the regression suite actually guards the fix, the body of `canonicalizeEvent`
was temporarily reverted to the broken `JSON.stringify(x, Object.keys(x).sort())`
array-replacer form and the tamper suite was run:

- broken serializer → 3 of 4 tamper tests FAIL (nested, proofValue, and top-level
  mutations all go undetected — the exact defect)
- correct serializer (restored) → 4 of 4 PASS

The temporary edit was reverted; the worktree is byte-identical to `origin/main`.

## Conclusion

No source change is required: the critical defect is already fixed and protected by
regression tests on `origin/main`. This plan records the verification so the finding
can be closed.
