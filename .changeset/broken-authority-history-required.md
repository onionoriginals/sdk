---
"@originals/cel": patch
---

**`verifyHistory` now rejects a no-prefix delta with a broken controller-authority chain as invalid**, instead of misclassifying it as merely needing its prior history (#746).

Previously, when `verifyHistory` was called with no `prefix`, the branch handling a delta (a log that doesn't start with `create`) only verified each entry's proof and its `previousEvent` chain link, then unconditionally threw `CEL_HISTORY_REQUIRED`. A delta signed by two different controllers with no `rotateKey` between them was misclassified as merely "needs its prefix," when it is actually self-contradictory and invalid regardless of what the real prefix turns out to be.

`verifyHistory` now tracks a provisional controller through the delta: the first entry's signer is only ever provisional (its own authorization genuinely depends on state this call wasn't given), but every later entry must be signed by whoever currently holds that provisional authority, updated only by `rotateKey`. A break throws `CelError('invalid', 'CEL_AUTHORITY', ...)`; an internally consistent delta still throws `CEL_HISTORY_REQUIRED` as before.
