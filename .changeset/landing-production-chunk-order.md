---
"@originals/landing": patch
---

Prevent the production homepage from rendering blank by preserving module initialization order across shared JavaScript chunks, and run the built app's browser lifecycle smoke test in CI.
