---
'@originals/landing': minor
---

A signed-in author's work is kept in IndexedDB (one database per account) and survives a browser restart: `DemoEngine.listOriginals()` lists it and `open(did)` reopens and verifies it, with a published Original's alias restored so its revisions go through the host. The store also retains the last reported anchor of an anchored Original (schema version 2, add-only), so a changed anchor is reported after a restart (P9.16). An open blocked by another tab waits instead of failing, a connection gives way to another tab's upgrade, and a failed open is retried on the next action. Signed in without IndexedDB, the page says the work isn't saved across restarts. Signed out, work stays in memory and is discarded with the page (#976 B, G2).
