---
"@originals/sdk": major
"@originals/cel": major
---

**BREAKING: sat-gated appends and the creator-vs-holder entry split.** Authority over a CEL splits at the btco anchor: before the migrate, the key decides (unchanged); after the migrate, the sat decides. A post-anchor event is authorized iff it commits its author's key in `data.author` (inside the chain digest), its single controller proof is that author's key, and it carries a fully verified `bitcoin-ordinals-2024` witness proof on the anchoring sat whose inscription strictly postdates the current anchor. The signer does NOT have to be in the authorized key set, and appending never modifies it.

Verifier (`@originals/cel`):

- Post-anchor `rotateKey`, `deactivate`, and `migrate` are rejected outright; a v1 `transfer` (`data.newController`) is rejected anywhere (the v0 legacy shape stays readable). Off-chain post-anchor appends — including the witness-acknowledgment updates earlier SDK versions wrote — no longer verify.
- Entries are classified: creator entries (signed by the genesis controller or a pre-anchor rotation — the authenticity claim) vs holder entries (post-anchor writes by the sat holder — chain of custody). Holder entries carry an ALLOWLISTED data shape (`author`/`statement`/`occurredAt`/`links`/`ext`); anything else fails the log. New public surface: `EventVerification.authorKey`/`authorClass`, `VerificationResult.creatorKeys`/`holders`, `AssetState.custody`/`holders`, and the pure display fold `classifyLogEntries`.
- `options.verifier` is documented as UNSAFE for btco logs: none of the on-chain authority machinery runs on that path.

SDK (`@originals/sdk`):

- `rotateBtcoKeys` always throws `KEY_ROTATION_NOT_PERMITTED`: a did:btco asset is definitionally past the anchor, so its output could never verify again. The controller key lineage is frozen at inscription time.
- Post-inscription witness-acknowledgment appends are no longer written (they would invalidate every new log). Serialized envelopes or hosted logs from earlier versions that carry a post-migrate acknowledgment update no longer verify — re-serialize from the chain (`resolveAssetFromSat`) to obtain the clean on-chain log.
- New `asset.appendStatement({ statement?, occurredAt?, links?, ext? }, { signer? })`: the sat holder's write. The append path signs with the caller's configured signer even when its key is not in the log, commits `data.author`, and refuses holder authenticity claims locally (`CEL_HOLDER_FIELD_NOT_PERMITTED`) before anything is inscribed or paid.
- `resolveAssetFromSat` now also returns `owner` — the sat's current holder, read live from the provider's owner index at call time, never cached; unset when no owner index exists.
- `ProvenanceChain.custody` + `ProvenanceQuery.custody()` expose the holder chain; `replayProvenance` folds holder entries into `custody`, never into `resourceUpdates`.
