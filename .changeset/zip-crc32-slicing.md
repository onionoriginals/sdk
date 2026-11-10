---
'@originals/sdk': patch
---

Compute evidence package CRC-32s three times faster.

`crc32`, run over every entry when a package is written (`package`) and read
(`load`, `import`), now processes eight bytes per step (slicing-by-8). The
values are the same as before, so archives are byte-identical (P14.10) and a
corrupted entry is still refused (`ARCHIVE_CRC`). For 25 resource versions of
680 KB, the CRCs drop from 44 ms to 14 ms on each write and each read.
