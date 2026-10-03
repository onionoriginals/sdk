---
---

Run stopped-endpoint network regressions in isolated Bun processes so both root
and scripts/regtest test invocations exercise real hanging, responding, and
refused connections without changing SDK fetch mocks.
