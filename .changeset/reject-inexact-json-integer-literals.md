---
'@originals/cel': patch
---

**Fix: CEL 3's JSON parser now rejects a plain decimal integer literal that isn't exactly representable in binary64, matching the CBOR transport's existing exactness check (#727).**

Previously, `decodeValue(..., "json")` accepted an out-of-range integer literal (e.g. `9007199254740993`) and silently rounded it to the nearest representable double (`9007199254740992`), while the CBOR transport already rejected the equivalent encoding with `CEL_NUMBER`. A plain integer literal that neither names its binary64 exactly nor is that binary64's RFC 8785 (JCS) spelling is now rejected as `CEL_NUMBER` from the JSON parser too, so the JSON reader still accepts everything the JCS writer emits. Numbers written with a fraction or exponent (e.g. `1e30`) are unaffected and keep ordinary IEEE 754 rounding, per RFC 8785 JCS.
