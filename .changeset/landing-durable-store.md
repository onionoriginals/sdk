---
'@originals/landing': minor
---

The browser's one Originals store is `BrowserOriginalsStore` (#992): signed in, the account's database; signed out, the guest's. It is hardened against other tabs: a connection gives way to another tab's schema upgrade, a blocked open waits instead of failing, each call opens the database again so a failed open is retried, and a resource's first bytes stay. Without IndexedDB, the engine keeps the work in memory and the page says it isn't saved across restarts. The page's own engine is `window.__originalsDemo` again, set by the page rather than by every engine (#976 B, G2).
