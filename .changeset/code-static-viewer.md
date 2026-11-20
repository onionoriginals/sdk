---
"@originals/code": minor
---

A static viewer that verifies repo bundles in the visitor's browser (plan 049 §6, milestone 1). `originals-code package --split <dir>` writes the split bundle (K19): the evidence packages and every tree and commit object load first, and each other object is fetched by digest when opened and checked on arrival; one not loaded is reported missing, never verified. `openSplitRepository` reads it with the zip bundle's verification code. `packages/code/viewer` renders the `serve` pages in a Web Worker with hash routing and a strict CSP, deployed at `/code/` of the Pages site.
