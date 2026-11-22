---
'@originals/sdk': patch
---

`hostedResourceLimit` (SDK option, and an option of `hostedFiles`) may lower the 64 MiB cap on a resource version that is published or sent to a shared host, never raise it (P8.5, P14.13). The cap tests no longer materialise and hash more than 64 MiB.
