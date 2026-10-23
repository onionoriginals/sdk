---
'@originals/landing': minor
---

A signed-in author's work is kept in IndexedDB (one database per account) and survives a browser restart: `DemoEngine.listOriginals()` lists it and `open(did)` reopens and verifies it, with a published Original's alias restored so its revisions go through the host. Signed out, work stays in memory and is discarded with the page (#976 B, G2).
