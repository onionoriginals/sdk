---
"@originals/sdk": patch
---

Fix: `updateDIDOriginal` could silently return `did: ""` on its `OriginalResult` instead of throwing when neither `result.did` nor the update log's last state carried a usable `id`. The function's own final error branch ("Cannot determine DID from update result") is now reachable in that case instead of being bypassed by an unconditional `|| ""` fallback.
