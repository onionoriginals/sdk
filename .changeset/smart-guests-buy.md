---
---

Tests-only + CI change (issue #362): adds missing assertions for already-shipped
behaviour (JWT sign/verify + #352 hardening, `canonicalizeSatoshi`, the VCDM 2.0
`validFrom` branch, and CLI-level CEL controller-key TOFU / btco-anchor gating)
and wires the throttled-network TTI budget check into `landing:ci`. No published
package behaviour changes, so this changeset is intentionally empty.
