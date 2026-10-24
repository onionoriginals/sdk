---
'@originals/vh': minor
'@originals/sdk': patch
---

Originals asset logs and inscription bodies follow section 14's form (P14.2, P14.3): `versionTime` must end in `Z` (no `+00:00`) with at most three fractional digits; each line is compact JSON ending in a single LF, so a missing final LF, CRLF or whitespace between tokens is rejected (`LOG_LINE_FORMAT`; an inscription body is `undecodable`); and an integer value outside the IEEE 754 safe range is rejected however it is written (`JSON_UNSAFE_NUMBER`). did:vh and did:webvh signer and alias logs, and plain VH-Log, are unaffected. `verifyLogText` takes `compactLines`, `compactLineError` is exported, and a specialisation's `versionTime` takes `utc: "Z"`.
