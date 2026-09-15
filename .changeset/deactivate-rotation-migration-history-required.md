---
"@originals/cel": patch
---

**`verifyHistory` now rejects three more classes of no-prefix delta as invalid** instead of misclassifying them as merely needing their prior history (#757), extending #746/PR #753's provisional-controller tracking to the other state that is fully decidable from a delta alone:

- A delta whose first entry is `deactivate`, followed by any other operation, is now `CEL_DEACTIVATED`/`invalid`. Deactivation is terminal under `specs/originals-cel-v3-authority.md` — no later authorship operation is ever accepted, regardless of what the real prefix would show.
- A delta containing a `rotateKey` whose `newController` equals the signer already holding provisional authority is now `CEL_ROTATION`/`invalid`. A rotation must change the controller; rotating to the current one can never be valid under any prefix.
- A delta containing two `migrate` operations where the second does not strictly progress `cel -> webvh -> btco` from the layer the first established (e.g. `webvh` followed by `webvh` again) is now `CEL_MIGRATION`/`invalid`.

An internally consistent delta that doesn't hit any of these still throws `CEL_HISTORY_REQUIRED` as before.
