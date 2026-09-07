---
"@originals/sdk": major
---

Upgrade JSON-LD processing to version 9 so published SDK installations use the
maintained Undici 6 HTTP client. Retained VC utilities use corrected RDFC-1.0
control-character escaping and complexity limits; affected older credentials may
need reissuing. CEL 3 event histories use independent canonicalization.
