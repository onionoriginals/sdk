---
"@originals/sdk": patch
"@originals/auth": patch
---

Ship `README.md` and `LICENSE` (MIT) in the published npm tarballs; previously neither package included them, so the npm pages rendered blank and `"license": "MIT"` shipped without license text. The SDK exports map also gains a `"default"` condition alongside `"import"` for compatibility with tooling that does not match the `import` condition (e.g. `require(esm)` consumers).
