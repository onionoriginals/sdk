# Design: Content-as-ordinal, provenance-in-metadata (epic #407, phase 2)

> Second increment of epic #407 ("The CEL lives on the sat"). Phase 1 (#409)
> made the log **byte-light** (content referenced by `toHash`, no embedded
> bytes). Phase 2 makes the anchoring inscription **be the asset**: its
> **content** is the asset's current media, its **metadata** carries the full
> provenance (DID doc + byte-light CEL log), and a resolver reconstructs +
> verifies the whole asset from a **bare sat** — no envelope, no host.
>
> **Stacks on #409** (needs the byte-light log). Branch off #409 /
> main-after-#409.

## 0. Decision record

- **The inscription IS the asset.** Content = the asset's **most recent
  resource** (current/latest version) as raw bytes + its real `contentType` — a
  real, viewable ordinal. Metadata (CBOR) = the byte-light provenance: the
  did:btco DID doc (with `#cel` anchor) + the full CEL log.
- **Always inscribe the content.** No size cap / no referenced fallback for the
  primary media — the current media is always on-chain. Older versions and
  secondary resources stay **referenced** (phase 1); their content inscription
  is a later, opt-in phase.
- **Provenance moves to metadata.** The DID doc + `#cel` commitment + log live in
  the inscription's metadata, not its content. The `#cel`/witness verification
  reads metadata; the content is verified separately (hash vs the log's
  most-recent-resource hash).
- **Point-in-time.** The metadata snapshot is the log as-of-inscription;
  `rotateBtcoKeys`/re-inscription re-embeds the current provenance + re-inscribes
  the current media (recoverable-as-of-last-inscription, per the #407 tiers).
- **Scope = write + read.** Phase 2 ships both the inscribe path and the
  reconstruction resolver, so "recoverable from a bare sat" is demonstrable.

## 1. Provider metadata plumbing

`commit.ts` already builds the inscription envelope with a `metadata` (CBOR) tag,
but the provider abstraction doesn't surface it. Add:
- `OrdinalsProvider.createInscription({ …, metadata?: Record<string, unknown> })`
  (write) — thread it to the existing `commit.ts` `metadata` tag.
- `getInscriptionById(id)` return gains `metadata?: Record<string, unknown>`
  (read) — so the SDK/verifier can read inscription metadata.
- `OrdMockProvider` echoes metadata round-trip for tests.

## 2. Writer — `LifecycleManager.inscribeOnBitcoin` / `rotateBtcoKeys`

Inside the existing `buildContent(satoshi)` window:
- **Content** = the most-recent resource's bytes (decoded from
  `AssetResource.content`), `contentType` = its media type. (Most-recent = the
  current head of the resource timeline: the latest `addResourceVersion` result,
  or the genesis resource if none.)
- **Metadata** = `{ didDocument: <did:btco doc with #cel anchor>, celLog:
  <byte-light log snapshot> }`.
- The `#cel` anchor still commits to the log head; the embedded `celLog` head
  MUST equal it.
Re-inscription (`rotateBtcoKeys`) re-embeds the then-current provenance + media.

## 3. Verifier — read provenance from metadata

`verifyBitcoinWitnessProof` / the `#cel` anchor check currently parse
`inscription.content` as the DID doc (`verifyEventLog.ts:395-418`). Under this
model they parse `inscription.metadata` instead: locate `didDocument` +
`#cel`/`digestMultibase` there; the commitment logic (`didDocumentCommitsToDigest`
/ `extractCelAnchorHeadDigest`) is unchanged, only its source moves
content→metadata. The inscription **content** is the media, verified by
`hashResource(content) == the log's most-recent-resource hash`.

## 4. Resolver — bare sat → verified asset

New resolution path (reuses #377 `loadAsset` for the provenance half):
1. `getInscriptionsBySatoshi(sat)` → pick the newest DID-doc/provenance-bearing
   inscription by confirmed block height (fail-closed on ambiguity, like
   head-freshness).
2. `getInscriptionById(id)` → read its `metadata` (provenance) + `content` (media).
3. Reconstruct the byte-light `AssetEnvelope` from the metadata's `didDocument` +
   `celLog`, plus the content as the most-recent resource blob → run `loadAsset`
   (which runs `verifyEventLog` + anchor + resource-binding).
4. Confirm the content hashes to the log's most-recent-resource `toHash`.
Returns the verified asset (log + folded state + current media) — from chain
alone.

## 5. Integrity / security

- Embedded `celLog` head digest MUST equal the `#cel` anchor `headDigestMultibase`
  (else reject — inconsistent inscription).
- `verifyEventLog` gates the reconstructed log identically to any log (chain
  origin never relaxes verification — anchored-sat, uniqueness, continuity all
  apply).
- Content hash-check fails closed: media not matching the log's most-recent hash
  → reject.
- Newest-inscription selection by block height, fail-closed on missing height /
  ties (mirrors head-freshness).

## 6. Boundaries / deferred (later #407 phases)

- Secondary resources + older versions: still referenced (phase 1); their content
  inscription is a later opt-in phase.
- Per-event inscription (the log as an inscription chain), the checkpoint/squash
  tier, and the fee/economics model.
- Real-time chain-recoverability of every append (this phase is point-in-time).

## 7. Testing spine

- **Bare-sat round-trip:** create → addResourceVersion → publish → inscribe; a
  resolver with ONLY the sat + provider reconstructs provenance (from metadata)
  AND the current media (from content), verified, with NO envelope/host.
- **Content hash-check:** an inscription whose content ≠ the log's most-recent
  resource hash → reject.
- **Provenance-in-metadata tamper:** a tampered metadata `celLog` →
  `verifyEventLog` rejects; embedded head ≠ `#cel` → reject.
- **Metadata plumbing:** createInscription metadata round-trips through
  getInscriptionById (OrdMock).
- **Point-in-time:** a resource update AFTER inscription is absent from the
  on-chain snapshot until re-inscription; `rotateBtcoKeys` re-embeds the updated
  provenance + media.
- **Most-recent selection:** with several resource versions, the inscribed
  content is the latest.

## 8. Changeset

`@originals/sdk` **minor** — the btco anchoring inscription now carries the
asset's current media as content and the full provenance (DID doc + byte-light
CEL log) in metadata; a new resolver reconstructs + verifies the asset from a
bare sat. Provenance is now recoverable from Bitcoin alone (#407).
