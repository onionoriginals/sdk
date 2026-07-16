# Design: Resource-update events on the CEL log

> did:cel epic — Phase 4, sub-project 1 of 5 (design spec
> `2026-07-10-cel-backbone-did-cel-design.md` §7 "Phase 4"). Turns post-genesis
> resource versions from advisory, unverifiable envelope metadata into signed
> CEL log events, so provenance for *every* authorship op — not just genesis —
> is cryptographically verifiable.

## 0. Decision record

- **Event type:** reuse the existing generic `'update'` CEL event type. A
  resource-update `update` is discriminated by carrying `resourceId` +
  `previousVersionHash`; the legacy migration-sniff heuristic keys off
  `sourceDid`/`layer`/`migratedAt`, which a resource update never carries — no
  collision in either direction.
- **Payload = the new file itself.** The `update` event embeds the new content;
  `toHash` is *derived* (`hashResource(content)`), never stored, so it cannot
  lie. This keeps a buyer verifying **offline** in possession of the actual file
  and does NOT touch the Bitcoin inscription byte-cap (#378) — a resource update
  is a log append; on-chain only ever commits to the log *head digest* via the
  `#cel` anchor.
- **Authoring stays on `OriginalsAsset.addResourceVersion`**, which gains an
  injected controller signer (bound by `LifecycleManager`); it becomes async and
  degrades with `cel:append-skipped` when no signer is available. `OriginalsAsset`
  becomes key-aware for this one op.
- **Hard cutover:** resource versions now MUST be signed `update` log events.
  `serialize()` stops emitting the advisory `unverified.resourceUpdates`;
  `loadAsset` folds versions from the log. Consistent with the project's
  hard-cutover stance (nothing released, no external consumers). Old test
  envelopes/fixtures regenerated.
- **Authority:** a resource update is authorship — signed by the **currently
  authorized** controller key (post-`rotateKey` authority), the same walk every
  other authorship event uses.

## 1. The gap today

`OriginalsAsset.addResourceVersion` (`src/lifecycle/OriginalsAsset.ts:549`) is
synchronous: it validates (Buffer rejected #276, content-unchanged rejected,
resource-exists), pushes the new version to the in-memory `this.resources`
array, and records a `this.provenance.resourceUpdates` entry — a **local array,
no CEL event**. `serialize()` emits those entries under
`unverified.resourceUpdates` (`OriginalsAsset.ts:222-223`), and `loadAsset`
reads them back as advisory, **unverifiable** metadata
(`LifecycleManager.ts:748`). So a post-genesis resource version has no
cryptographic backing: a buyer cannot prove the creator authored it.

## 2. Model — the signed `update` event

```
event: {
  type: 'update',
  data: {
    resourceId,
    content,               // the new file (string; AssetResource.content is a string)
    contentType,
    previousVersionHash,   // link: the prior version's hash (genesis hash for the 1st update)
    toVersion,             // the new version number (advisory/among the signed body)
  },
  previousEvent,           // CEL hash-chain link (as every event)
  proof: [ controllerProof ],
}
```

- `toHash` is not stored; it is `hashResource(Buffer.from(content, 'utf-8'))`,
  derived at verify/fold time. The signed event commits to `content` (the chain
  digest covers `data`), so `toHash` is tamper-evident.
- `previousVersionHash` is the continuity link: it MUST equal the last-known hash
  of `resourceId` at this point in the log (the genesis resource hash for the
  first update, or the prior update's derived `toHash` for subsequent ones).

## 3. Writer — `OriginalsAsset.addResourceVersion` (now async)

Signature becomes `addResourceVersion(...): Promise<AssetResource>`. It keeps its
current guards, then instead of pushing to `provenance.resourceUpdates`:

1. Computes `newHash`/`newVersion` as today.
2. Appends a signed `'update'` CEL event with the §2 body, via the **injected
   controller signer** (bound by `LifecycleManager` when a keyStore is present),
   using the shared signer-adapter path (`celSignerFromKeyPair` /
   `createKeyStoreCelSigner`) that every other authorship append uses.
3. On success, updates the in-memory `this.resources` (so live use sees the new
   version) — the log is the source of truth; `provenance.resourceUpdates` is no
   longer written locally (it is folded from the log, §5).

**Degraded mode (no signer):** the in-memory `this.resources` still updates so
the object is usable, but no `update` event is appended and the manager emits
`cel:append-skipped` — the version is NOT provable, exactly the honesty pattern
`createAsset`/`inscribeOnBitcoin` already follow when keyless.

**Signer injection:** `LifecycleManager` binds a controller signer into the
`OriginalsAsset` it constructs (in `createAsset` and `loadAsset`) when a keyStore
is configured; `addResourceVersion` reads it. No key material is passed by
callers; `OriginalsAsset` holds a reference to the signer for its lifetime.

## 4. Verifier — `verifyEventLog` resource-`update` branch

When an `update` event is resource-shaped (`data.resourceId` +
`data.previousVersionHash` present, and NOT migration-shaped):

1. **Continuity:** `data.previousVersionHash` MUST equal the last-known hash for
   `data.resourceId` — the genesis resource hash on the first update, or the
   prior resource-update's derived `toHash` thereafter. A mismatch fails the log.
2. **Content binding:** `hashResource(data.content)` becomes the new current hash
   for `resourceId` (fed to the next continuity check). Because the chain digest
   already covers `data`, tampering with `content` breaks the hash chain / proof.
3. **Authority:** the event's controller proof MUST be the currently authorized
   controller key (the same authorized-key-set walk migrate/rotateKey/update use)
   — an update signed by a non-controller or a pre-rotation key fails the log.

The verifier tracks a per-`resourceId` "current hash" map across the walk,
seeded from the genesis resources, so continuity is checkable with no external
input (content is inline).

## 5. Fold + envelope (hard cutover)

- `replayProvenance` / `getCurrentState` reconstruct current resource versions
  **from the `update` events**; `ProvenanceChain.resourceUpdates` is derived from
  the log, not a local array.
- `serialize()` **stops emitting `unverified.resourceUpdates`**
  (`OriginalsAsset.ts:222-223` removed); the resources it captures are the folded
  current versions.
- `loadAsset` folds resource versions from the verified log; the
  `unverified.resourceUpdates` read (`LifecycleManager.ts:748`) is removed.
- Old test envelopes/fixtures carrying `unverified.resourceUpdates` are
  regenerated to append real `update` events.

## 6. Unchanged

`did:cel` derivation, the migration/rotation/ownership machinery, genesis
resource binding (`checkGenesisResourceBinding` still gates genesis; updates
chain forward from it). The `'update'` event type keeps working for its existing
(legacy migration-sniff) uses — the discriminator separates the two.

## 7. Testing spine

- **Honest round-trip:** genesis → `addResourceVersion` → `serialize()` → a
  FRESH SDK `loadAsset` verifies the new version with NO keys (content is inline);
  the folded current resource matches.
- **Chain-continuity attack:** an `update` whose `previousVersionHash` does not
  match the prior known hash → rejected.
- **Content-tamper:** flip a byte of the embedded `content` after signing → the
  chain digest / proof breaks → rejected.
- **Unauthorized signer:** an `update` signed by a non-controller (or a
  pre-`rotateKey` key) → rejected.
- **Degrade:** no signer → `cel:append-skipped`, in-memory version present but
  NOT in the log (not provable), asserted explicitly.
- **No heuristic collision:** a resource `update` is not mistaken for a legacy
  migration, and a legacy migration `update` is not mistaken for a resource
  version.
- **Authority-after-rotation:** an `update` signed by the NEW controller after a
  `rotateKey` verifies; one signed by the retired key does not.

## 8. Out of scope / deferred

- Inline-vs-referenced storage + size caps for large resource content — the
  default is inline (like genesis today); an opt-in reference-by-hash for big
  blobs is a later refinement, and on-chain inline-content mechanics are the
  separate #378 sub-project.
- VC/credential derivation from these events (Phase 4 sub-project 2) — builds on
  this once resource authorship is on-log.
- Re-inscribing an updated `#cel` head on Bitcoin after a resource update
  (freshness of the on-chain anchor) — orthogonal; today only migrate/rotate
  re-embed `#cel`.
