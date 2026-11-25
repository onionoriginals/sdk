---
"@originals/sdk": minor
"@originals/vh": minor
---

`@originals/sdk/og` and the `originals-og` command: anchor a new did:og
Original on Bitcoin. It creates a did:webvh author (default
`did:webvh:<SCID>:originals.build:authors:<name>`), prints its `did.jsonl` and
the URL to serve it at and waits until it resolves; builds and signs the
genesis and anchoring entries with the P9.30 body mode; shows a taproot
funding address and exact amount; after the funding output confirms, finds
the sat, signs the anchoring entry for it and checks the local copy (P9.18);
broadcasts the commit and reveals through mempool.space or Bitcoin Core with
no pointer; and reads everything back from an ord explorer to compute the
report from exactly the P9.18 evidence set, writing `last-run.json`.
`@originals/vh/og` gains `verifyLocalCopy` (P9.18).
