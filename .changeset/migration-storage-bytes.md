---
"@originals/sdk": patch
---

Fix experimental migration storage in runtimes without a global Buffer. Decode raw and enveloped Uint8Array results with TextDecoder and encode legacy writes with TextEncoder, preserving UTF-8 BOMs, byte-view boundaries, and Buffer-based legacy Node adapters. Canonical string writes and missing-result behavior are unchanged.
