# Design: Content-addressed separation (epic #407, phase 1)

> First increment of epic #407 ("The CEL lives on the sat"). The log must be
> **small** before it can be affordably inscribed on Bitcoin (phase 2). Today
> resource-update events (#401) **embed the file bytes** inline, so the log
> literally contains content — making it big/expensive to inscribe. This phase
> moves content **out of the log** into a content-addressed store, so log events
> carry only hashes. It is a **rework of the just-merged #401**.

## 0. Decision record

- **Separate content from the log:** resource-update events reference content by
  **hash** (a signed `toHash`), never by embedded bytes. Content lives in the
  content-addressed store (the asset `resources` array / `serialize()` envelope
  blobs / webvh host), keyed by hash — exactly where genesis content already
  lives (genesis references `digestMultibase`, never bytes). This makes updates
  symmetric with genesis.
- **Offline verify is preserved:** the `serialize()` envelope still carries the
  content **blobs alongside** the small log; `loadAsset` binds `hash(blob) ==
  the event's toHash`. Same guarantee #401 gave, generalized (this IS the
  content-binding the #401→5/5 fix already added).
- **No inscription here:** phase 1 changes only the log/event shape and storage.
  Inscribing the (now-small) log for on-chain provenance is phase 2. The
  reference `locator` holds a webvh URL now and will upgrade to a
  `did:btco:<sat>` pointer in the inscription phases.
- **Hard cutover:** nothing released. #401-shaped logs (content embedded in the
  event) are regenerated to the reference shape.

## 1. The event-shape change

Resource-update `update` event `data` today (embeds bytes):
```
{ resourceId, content, contentType, previousVersionHash, toVersion }   // toHash derived from content
```
Becomes (reference only):
```
{ resourceId, contentType, previousVersionHash, toHash, toVersion, locator? }
```
- `toHash` is now a **stored, signed** field (the content isn't in the event to
  derive it from). `previousVersionHash` unchanged.
- `locator?` — optional retrieval hint (a webvh URL now; a `did:btco:<sat>`
  pointer once inscribed). Advisory: never the root of trust (the hash is).
- The bytes are removed from the event entirely.

## 2. Where content lives (content-addressed store)

- **In-memory:** the asset's `resources` array (unchanged — `AssetResource.content`).
- **Interchange:** `serialize()` captures resources as content-addressed blobs
  keyed by hash, carried **alongside** the small log in the envelope. (Genesis
  resources already ride this way; resource-update versions now join them
  instead of living in the log.)
- **Hosted:** webvh continues to host content by URL (free, live).
- The log/event holds only `toHash` (+ advisory `locator`).

## 3. Writer — `OriginalsAsset.addResourceVersion`

Unchanged externally (still async, injected signer, `cel:append-skipped` /
`UNPROVABLE_BASE` degrade). Internally: it appends the **reference-shaped** event
(no `content` in `data`; `toHash` computed from the new bytes and stored) and
keeps the new bytes in the `resources` array / content-addressed store. The
byte-embedding is removed.

## 4. Verifier — `verifyEventLog`

The resource-update branch (`checkResourceUpdateContinuity`) now checks **only
hash-chain continuity**: `data.previousVersionHash` must equal the last-known
hash for `resourceId` (genesis digest for the first update, prior `toHash`
after), and `data.toHash` becomes the new current hash. It no longer recomputes
`hash(content)` from the event (there is no content in the event). Content
integrity (does a blob actually hash to `toHash`) moves to `loadAsset`.

## 5. `loadAsset` / envelope

`loadAsset` keeps and generalizes the #401→5/5 content-binding: for every
envelope resource (genesis AND update versions, all `v≥1`), require it match a
log-declared hash — `hash(blob) == the event's toHash` (or the genesis digest),
by `(resourceId, version)` — else `ASSET_LOAD_VERIFICATION_FAILED`. `serialize()`
emits the content blobs in the envelope; the log it emits is byte-light.

## 6. Deferred (later #407 phases)

- Inscribing the small log on-chain (phase 2) — the payoff this enables.
- `did:btco:<sat>` content-address upgrade of the `locator` (content inscription
  phases).
- The reconstruction resolver (bare sat → rebuild log → verify).

## 7. Testing spine

- **Migration round-trip:** an asset with resource updates → `serialize()` →
  fresh-SDK `loadAsset` verifies offline with the content blobs (no host); the
  log carries no bytes.
- **Content-tamper:** a blob that doesn't hash to the event's `toHash` → rejected
  at load (`ASSET_LOAD_VERIFICATION_FAILED`).
- **Chain-continuity:** `previousVersionHash` mismatch → rejected (unchanged).
- **Byte-light log:** assert a resource-update event's `data` contains no
  `content` field and the serialized log size is independent of content size.
- **Authority-after-rotation** and **degrade** (`cel:append-skipped` /
  `UNPROVABLE_BASE`) still hold.

## 8. Changeset

`@originals/sdk` **minor/breaking** — resource-update CEL events now reference
content by hash (`toHash`) instead of embedding bytes; content travels as
content-addressed blobs in the envelope. Reverses #401's embed-the-bytes shape.
Foundation for on-chain log inscription (#407).
