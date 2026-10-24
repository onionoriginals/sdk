---
'@originals/sdk': minor
'@originals/landing': minor
---

Shared-host saves (P6.7, P6.8). The SDK adds `sign` (a verified candidate against the exact parent, not yet history), `submit` (send it to a `SharedHost`; commit locally only once the host accepts or already accepted it), `refused`, `sync` and `reconcile`. A stale-parent refusal keeps the draft and the signed candidate, labelled `refused`, beside the log; the SDK never commits, packages, publishes or submits it again, and `reconcile` has the caller's signer sign the caller's reconciled change against the host's verified new head. Stores add `putRefused`/`getRefused`/`dropRefused`; `retrieveHosted` reads a hosted snapshot unverified for a host's `accepted`.

The landing host adds `POST /api/originals/submit/<site key>`: byte-identical retries return their checkpoint and the current head, otherwise only an entry extending the accepted head and verifying under the profile is accepted, in one serialized compare-and-replace per Original, with bytes stored before the head is published. A stale parent is a 409 naming the head. The signed entry authorizes the change; the caller must be the namespace owner or an account whose landing did:webvh the head state names as author or granted editor, and any other caller gets a 403 before its body is read (owner decision of 22 October 2026; P5.15). A hosted asset log can no longer be replaced by one that does not extend it. The engine saves published Originals through the host (still behind `hostedPublication`, off).
