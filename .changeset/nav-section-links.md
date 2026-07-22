---
"@originals/landing": patch
---

Fix header nav links being dead on the `/me` (Your Originals) route. The nav renders on every route, but its in-page section anchors (`#why`, `#demo`, `#protocol`, `#developers`, and the wordmark's `#top`) had no target when those sections weren't mounted — so on `/me` only the JS-driven buttons (Sign out, Your Originals) responded. A shared `goToSection()` now routes home first when off `/`, then smooth-scrolls to the section once it mounts (and smooth-scrolls in place when already on `/`).
