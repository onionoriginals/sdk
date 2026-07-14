# Plan: Content-addressed separation (epic #407, phase 1)

Reworks the just-merged #401. Resource-update CEL events stop embedding file bytes;
they reference content by a **signed `toHash`** (+ optional `locator`). Content lives
in the content-addressed store (the `resources` array / `serialize()` envelope blobs).
Offline verify is preserved: `loadAsset` binds `hash(blob) == toHash` (or genesis digest).

Spec: `docs/superpowers/specs/2026-07-14-content-addressed-separation-design.md`

## Event shape

`update` event `data`:
- BEFORE (#401): `{ resourceId, content, contentType, previousVersionHash, toVersion }` (toHash derived from content)
- AFTER: `{ resourceId, contentType, previousVersionHash, toHash, toVersion }` (no bytes; toHash signed)

`toHash` / `previousVersionHash` are hex sha256 (same encoding as `AssetResource.hash`).

## TDD tasks (each: write/convert test → run red → implement → green → commit)

### Task 1 — Writer: `OriginalsAsset.addResourceVersion` appends reference-shaped event
- Convert `tests/unit/lifecycle/addResourceVersion.celevent.test.ts`: assert the bound
  appender receives `toHash` (= `hash('v2')`) and NO `content` field.
- Impl: `#addResourceVersionCritical` calls appender with
  `{ resourceId, contentType, previousVersionHash: currentResource.hash, toHash: newHash, toVersion: newVersion }`.
  Bytes stay in `resources` (already pushed). External behavior (async, degrade,
  UNPROVABLE_BASE, cel:append-skipped) unchanged.

### Task 2 — Verifier: continuity on signed `toHash`, stop hashing content
- Convert `tests/unit/cel/resource-update-events.test.ts`: all `update` bodies use
  `toHash: hex('vN')` not `content`. Rework "content-tamper" → tamper `toHash` after
  signing breaks the controller signature (still rejected).
- Impl `checkResourceUpdateContinuity`: take `{ resourceId, previousVersionHash, toHash }`;
  require `toHash` string; chain `previousVersionHash` → last-known (genesis digest / prior
  toHash); set current = `hexSha256ToDigestMultibase(toHash)`. No `hashResource(content)`.
- Impl caller in `verifyEventLog`: discriminator still `resourceId` + `previousVersionHash`;
  pass `toHash` through.

### Task 3 — `loadAsset` content-binding generalization
- Convert `tests/integration/ResourceUpdateHandoff.e2e.test.ts` "content-tamper" test:
  tamper the ENVELOPE BLOB (`envelope.resources` v2 content) so `hash(blob) != toHash`
  → rejected at load. (Log event no longer carries content.)
- Impl `loadAsset`: for every v≥2 resource, require a matching verified `update` event by
  `(resourceId, toVersion)` and `hash(content) == match.toHash` DIRECTLY (content integrity
  vs the SIGNED toHash, not transitively via `res.hash`). Genesis (v1) content binding
  unchanged (checkGenesisResourceBinding + inline self-consistency). Fail closed.

### Task 4 — Fold: `replayProvenance` reads `toHash` from the field
- Convert `tests/unit/lifecycle/replayProvenance.test.ts` (line ~245) to `toHash` shape.
- Impl: discriminator `resourceId && previousVersionHash && toHash`; `toHash: data.toHash`
  (field, not derived); `fromHash: previousVersionHash`.

### Task 5 — Byte-light log test + serialize confirmation
- Add e2e assertions: a resource-update event's `data` has NO `content`; serialized log
  size is (near-)independent of content size. `serialize()` needs no structural change —
  the log is byte-light by construction once the writer stops embedding.

### Task 6 — fable reviewer on verifier/loadAsset/serialize diff; fix Critical/Important.

### Task 7 — changeset `.changeset/content-addressed-separation.md` (minor/breaking).

## Verify
`bun run build` → `bun test` (0 fail) → `bunx tsc --noEmit` clean. Commit after every task.
