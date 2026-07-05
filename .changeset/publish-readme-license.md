---
"@originals/auth": patch
---

Ship `README.md` and `LICENSE` (MIT) in the published npm tarball; previously the package included neither, so the npm page rendered blank and `"license": "MIT"` shipped without license text. (The same fix for `@originals/sdk`, plus its `"default"` export condition, is recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
