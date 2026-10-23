---
'@originals/sdk': minor
'@originals/landing': minor
---

Shared-host saves (P6.7, P6.8). The SDK adds `sign` (a verified candidate against the exact parent, not yet history), `submit` (send it to a `SharedHost`; commit locally only once the host accepts or already accepted it), `refused`, `sync` and `reconcile`. A stale-parent refusal keeps the draft and the signed candidate, labelled `refused`, beside the log; the SDK never commits, packages, publishes or submits it again, and `reconcile` has the caller's signer sign the caller's reconciled change against the host's verified new head. Stores add `putRefused`/`getRefused`/`dropRefused`; `retrieveHosted` reads a hosted snapshot unverified for a host's `accepted`.

The landing host adds `POST /api/originals/submit/<site key>`: byte-identical retries return their checkpoint and the current head, otherwise only an entry extending the accepted head and verifying under the profile is accepted, in one serialized compare-and-replace per Original, with bytes stored before the head is published. A stale parent is a 409 naming the head. Any signed-in caller may submit; the signed entry authorizes the change. A hosted asset log can no longer be replaced by one that does not extend it. The engine saves published Originals through the host (still behind `hostedPublication`, off).
