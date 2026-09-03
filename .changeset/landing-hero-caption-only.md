---
"@originals/landing": patch
---

**The hero ends on one line instead of a diagram.**

The hero used to close with an animated did:cel → did:webvh → did:btco pipeline inside a card, captioned "One asset, three layers: private draft, public, inscribed on Bitcoin. Each step signed. The path only moves forward." The pipeline is gone from the hero and that line now stands on its own under the calls to action, as plain text with `text-wrap: pretty` so it never orphans its last word. The Protocol section and the live demo still draw the full three-layer pipeline; only the hero's copy is removed. `hero.pipelineCaption` is renamed `hero.caption`, the copy unchanged, and a test pins that the line still names the three layers and Bitcoin in a single line now that nothing sits beside it.
