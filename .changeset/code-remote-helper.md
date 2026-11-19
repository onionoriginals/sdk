---
"@originals/code": minor
---

`git-remote-originals` (plan 049 phase 5, K16): `git clone originals::<bundle path or URL>` verifies the bundle offline, refuses unless the canonical head is agreed and every commit id is recomputed, and rebuilds byte-identical commits (first-parent only; merges' second parents listed in `.git/info/grafts`). `git fetch` takes later bundles; push is not supported.
