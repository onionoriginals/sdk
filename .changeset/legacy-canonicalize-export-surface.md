---
"@originals/cel": major
"@originals/sdk": patch
---

`canonicalizeEvent`, `witnessSigningBytes`, `canonicalizeEntryForChain`, `committedFields`, and `celProofSigningInput` are no longer exported from the `@originals/cel` package root. They move behind an explicit `@originals/cel/legacy` subpath.

Closes #599 ("Legacy `@originals/cel` root canonicalizer is not RFC 8785 and can omit signed members").

These previous-format canonicalization primitives rebuild each nested object into a plain `{}` literal and assign into it by bracket notation. An event whose data carries a genuine own `__proto__` member (as `JSON.parse` — unlike assignment — produces) is silently dropped: `sorted["__proto__"] = value["__proto__"]` sets the object's prototype instead of defining a data property, so the member never reaches the final `JSON.stringify`. Two events differing only in such a member canonicalize, hash, and sign identically — a canonicalization-smuggling gap.

The fix is not to repair the algorithm: previous-format signed history was produced against these exact byte preimages, and changing them in place would invalidate every already-signed event log rather than fix anything. `@originals/cel/v3`'s `canonicalizeValue` already closes this gap for new history (it copies into a null-prototype object before serializing, so `__proto__` is a real key), and was never affected. This PR only stops advertising the flawed previous-format writer as the default root API; it remains fully available, byte-for-byte unchanged, at `@originals/cel/legacy` for the retained previous-format lifecycle and its own regression suite.

- `@originals/sdk`'s internal previous-format consumers (`lifecycle/LifecycleManager.ts`, `crypto/signingInput.ts`, and their test suites) now import these five functions from `@originals/cel/legacy` instead of the package root. This is purely an import-path change; none of these are part of `@originals/sdk`'s own public export surface.
- New regression `packages/cel/tests/unit/legacy-canonicalize-export-surface.test.ts` asserts the package root has no own export for any of the five functions, that `@originals/cel/legacy` still exposes all five as functions with byte-identical output, and documents the exact `__proto__`-drop defect against `celV3.canonicalizeValue`'s correct handling of the same input.
