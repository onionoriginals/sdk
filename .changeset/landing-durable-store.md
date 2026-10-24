---
'@originals/landing': minor
---

The browser's one Originals store is `BrowserOriginalsStore` (#992): signed in, the account's database; signed out, the guest's. It is hardened against other tabs: a connection gives way to another tab's schema upgrade, a blocked open waits instead of failing, each call opens the database again so a failed open is retried, and a resource's first bytes stay. The page chooses its engine's store (`pageStore`); without IndexedDB it keeps the work in memory and says it isn't saved across restarts. A plain `DemoEngine` keeps its work in memory, as before. On a staging acceptance build only, the page's engine is `window.__originalsDemo`; production never exposes it (#976 B, G2).
