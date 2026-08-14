---
"@originals/sdk": major
---

**Custody is required, and a provenance append that cannot be signed now fails loudly** (plan 041).

Two defaults are inverted. Both used to produce assets that looked fine and were quietly broken.

**`createAsset` requires somewhere to keep the controller key.** Without a signer or a keyStore the freshly generated key was discarded at mint, so the asset could never author another event — `publishToWeb` and `inscribeOnBitcoin` would still "succeed" while omitting their provenance events. That was the default, and the shape of the documented quickstart. It now throws `NO_CUSTODY` naming every way to supply custody. `{ controller: 'ephemeral' }` is the explicit opt-in for a genuinely write-once asset; it still verifies, it simply can never gain another event.

**A lifecycle operation that cannot sign its own event throws `CEL_APPEND_FAILED`** instead of emitting `cel:append-skipped` and carrying on. An operation has not succeeded if the log is missing the migration it just performed. The old behavior is available per call (`{ onAppendFailure: 'skip' }` on `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys`, `addResourceVersion`) or globally (`config.onAppendFailure`), and still emits `cel:append-skipped`.

One exception, deliberately: `NO_CEL_LOG` — a legacy pre-CEL asset with no chain to append to — always degrades. No configuration could give such an asset a log, so gating on it would refuse to operate on them at all, which is a different and much harsher policy than "you have a log but cannot sign it".

**`rotateBtcoKeys` accepts `incomingSigner`.** The post-rotation witness acknowledgment folds to the NEW controller, so the outgoing signer cannot sign it. Without this a remote-custody rotation completed but dropped its acknowledgment — the last silently-dropped event in the lifecycle. The acknowledgment remains non-gating.

**`config.keyStore` is honoured however the manager is constructed.** `OriginalsSDK.create` destructured `keyStore` out of the config it passed downstream, so anything reading custody from the config — including a `LifecycleManager` built directly from it — saw none. `KeyStore` is also now documented as key *persistence* rather than a signing authority; prefer `signer` for authorship.

**Breaking:**

- `createAsset` / `createDraft` throw `NO_CUSTODY` unless a signer, a keyStore, or `{ controller: 'ephemeral' }` is supplied.
- `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys` and `addResourceVersion` throw `CEL_APPEND_FAILED` where they previously degraded. Pass `onAppendFailure: 'skip'` for the old behavior.

Callers relying on the old defaults were, in every case, producing assets whose provenance logs were missing events they believed had been recorded.
