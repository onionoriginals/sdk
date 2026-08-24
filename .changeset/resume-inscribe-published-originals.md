---
"@originals/landing": patch
---

**Feature: finish a published Original that never reached Bitcoin, instead of re-running the demo.**

A published Original that was never inscribed showed on `/me` with no way to inscribe it, and the detail page had no Bitcoin action at all — so the creator re-ran the demo and ended up with a second, different `did:webvh` Original.

Closing that gap turned out to be a custody problem, not a UI one. An Original is a CEL, every lifecycle step appends a signed event to it, and the key that signed those events was minted by `createAsset` into the DemoEngine's in-memory Map and destroyed with the tab. Verified before writing anything: after create + publish in Chromium, `localStorage` is empty while the CEL genesis controller reads `did:key:z6Mkks2HT…`. Nothing could sign a later `migrate` event, so no button could have worked.

Turnkey already provisions two `CURVE_ED25519` accounts per sub-org that nothing signed with. Ed25519 is what CEL requires, and Turnkey custody is what a browser-local seed is not: it comes back with the session on any device. A signed-in creator's Originals are now authored by that key from genesis onward, passed per-call so `Demo.tsx` is untouched — and `publish`/`inscribe` must use the same key, because pre-anchor the CEL accepts only its current controller as signer.

`/me` and `/me/<did>` now offer "Inscribe on Bitcoin" for a row that was never built. It rebuilds the asset from the artifacts the Original hosts (`hostedAssetEnvelope` → `loadAsset`, verifying the signed chain, resource-to-genesis binding and DID-doc cross-checks fail-closed) and hands it to the existing `engine.inscribe({ funding })` — that path is not forked. Funding comes from the app's own `GET /api/btc/deposit` and the same `selectFundingUtxos` the demo uses; no fee estimation or selection rule is reimplemented here, and it refuses before building anything if the deposit does not cover the quote.

Finish and Inscribe are decided by one shared selector and never both appear on a row: rebuilding over signed, paid-for transactions would strand that spend.

**One limitation, stated plainly.** Originals created *before* this change answer to a controller key that only ever existed in one tab and is gone. They cannot be inscribed, by anyone, on any device — the action is disabled for them with copy that says so rather than implying another device would help, and says what remains true: their history stays signed, verifiable and hosted. Only Originals created from now on are resumable.
