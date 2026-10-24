---
'@originals/vh': minor
'@originals/sdk': patch
---

Originals asset logs and inscription bodies follow section 14's form (P14.2, P14.3; the reader rules as worded in originals-spec #51, merged at master `19d3e82a0`): `versionTime` must end in `Z` (no `+00:00`) with at most three fractional digits; each line is compact JSON ending in a single LF, so a missing final LF, CRLF or whitespace between tokens is rejected (`LOG_LINE_FORMAT`; an inscription body is `undecodable`); and a number whose exact decimal value as written has magnitude greater than 2^53 − 1 is rejected (`JSON_UNSAFE_NUMBER`; `9007199254740991.4` included, judged on the text), as is any negative zero. did:vh and did:webvh signer and alias logs, and plain VH-Log, are unaffected. `verifyLogText` takes `compactLines`, `compactLineError` is exported, and a specialisation's `versionTime` takes `utc: "Z"`.
