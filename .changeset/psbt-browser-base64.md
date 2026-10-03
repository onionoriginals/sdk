---
"@originals/sdk": patch
---

Fix the retained PSBTBuilder's browser fallback to encode UTF-8 payloads as base64 without Node globals. Throw a structured encoding error instead of silently returning raw JSON when encoding is unavailable or fails.
