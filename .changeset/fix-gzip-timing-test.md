---
"@originals/sdk": patch
---

Fix gzip-bomb timing test flakiness under full-suite concurrent load. The test creating a 400 MB bomb was hitting Bun's default 5 s timeout and the 300 ms decompression threshold was too tight for CI hardware. Raised test timeout to 60 s and elapsed threshold to 2000 ms (unsliced baseline is ~8800 ms, so the regression catch is preserved).
