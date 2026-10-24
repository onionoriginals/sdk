---
'@originals/landing': patch
---

Fix the production bundle crashing on load (`Class extends value undefined`): `@originals/sdk`, `@originals/vh` and their `@noble`/`@scure` dependencies now share one `sdk-core` chunk, so no chunk import cycle can evaluate noble's HashMD after RIPEMD-160. `landing:check` fails on any static chunk import cycle, and CI boots the built app in headless Chromium.
