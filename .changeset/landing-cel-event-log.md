---
"@originals/landing": patch
---

Show the asset's real Cryptographic Event Log in the live demo, replacing the SDK emitter-event stream.

The demo's first tab streamed `asset:created` / `resource:published` / `asset:migrated` — app-level notifications the SDK emits to your code. Those are not the provenance record. The asset **is** its CEL, and the landing page never showed it: the signed chain only appeared on the authenticated `/me/<did>` page.

The tab now renders the log itself, built entry by entry as the pipeline runs: each event's type, a plain-English gloss of what its signed body asserts, the `did:key` that signed it, its proof value, and — drawn *between* entries, because it is entry N's claim about entry N-1 — the `previousEvent` digest that chains them. Entries are accented by destination layer, matching the pipeline above.

`DemoAssetState` gains a `celLog` field, read defensively from `OriginalsAsset.celLog` so an unexpected shape degrades to an empty chain rather than breaking a lifecycle step.
