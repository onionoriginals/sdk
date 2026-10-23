---
'@originals/landing': minor
---

A signed-in author sees "Your Originals": the ones this browser keeps, and those published from another device. Publishing records the Original's alias in the account index (`POST /api/originals` takes an optional `alias`, which must be in the caller's own namespace, must be named for that Original, and never changes once recorded). `DemoEngine.restore(did)` fetches the host's accepted log on a client that doesn't hold it, verifies it, reads it back as a stranger, and continues editing from the host's head with the author's own signer (#976 B, G3).
