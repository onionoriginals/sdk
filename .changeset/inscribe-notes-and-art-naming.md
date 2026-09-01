---
"@originals/landing": patch
---

**The notes under the pipeline were unstyled, and titles could change without the art.**

`.demo-inscribe-note` had no CSS rule at all — not a wrong one, none. Nine call sites used it (the mock disclaimer, the sign-in prompt, the deposit and session notes), so all nine rendered as raw `<p>`: body-sized, default margins, full-strength colour. They read as page copy that had escaped its card and collided with the panels above and below. Only `.demo-sim-note` carried a rule, contributing a dashed left border and no type styling — the stray vertical line. These are asides about the step, and are now typed like the other asides.

**A new name now arrives with new art, and only then.** The "New name" button rolled a title from a random nonce, so a name could change while the picture stayed put — the two came apart, which is the opposite of the intent. The button is gone. Regenerating, or changing style, re-rolls the title *provided it is still the one that `(style, nonce)` generates*. That check needs no dirty flag, never overwrites a title the visitor typed, and recognises a restored title as generated again after Discard.

Start over now takes a fresh name with its fresh artwork instead of carrying the previous run's title, and resets the source to Generate — an upload from the last run is not a clean slate.
