---
"@originals/sdk": patch
---

`AssetResolver.observe()` no longer loses its documented bounded retry on
Bitcoin chain movement when a `chainValidator` is configured. Previously, a
configured validator was consulted unconditionally, before the check that
classifies a snapshot whose `tipBefore` and `tipAfter` disagree as the benign,
retryable `"chain-changed"` status. A real independent validator legitimately
disagrees when it re-checks that already-stale `tipBefore` against the node's
current (moved-on) tip, and the outer catch handler only recognized a literal
`"SAT_SNAPSHOT_CHAIN_CHANGED"` error code that is never actually thrown — so
every validator-thrown error fell through to `"incomplete"` with no retry.
The validator is now only consulted when the snapshot itself is already
chain-stable; a mid-observation movement is classified as `"chain-changed"`
the same way it is when no validator is configured at all.
