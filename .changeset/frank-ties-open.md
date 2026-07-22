---
"@originals/landing": patch
---

Warn loudly at boot when durable Originals will not persist. On a deployed instance (Railway markers / `NODE_ENV=production`) with the auth API enabled but `ORIGINALS_DATA_DIR` unset, the server now logs the resolved durable dir and a prominent warning that signed-in users' Originals are being written to an ephemeral container path and will be lost on redeploy. Warn-not-throw: the anonymous demo and Track-A did:webvh hosting still run without durable storage.
