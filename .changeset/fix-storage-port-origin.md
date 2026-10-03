---
"@originals/sdk": patch
---

Fix LocalStorageAdapter originDomain mode to accept matching port-bearing HTTPS base URLs. Canonicalize advertised origins (including default HTTPS port equivalence), preserve configured-domain storage routing, and reject unsafe origin configuration before writing files.
