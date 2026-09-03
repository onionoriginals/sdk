---
"@originals/landing": patch
---

**The hero pipeline drops the DID method names.**

Each node in the hero's did:cel → did:webvh → did:btco pipeline carried two labels: the mono method name and, under it, the layer's role. A first-time visitor was meeting three DID method names before anything the page had explained. The hero now shows only the role line — Private draft, Public discovery, Bitcoin ownership — via a new `showNames` prop on `Pipeline`, off in the hero and on everywhere else, so the demo's pipeline is unchanged. On narrow screens, where the pipeline previously hid the role and kept the name, the role stays visible when the names are off so each node still has a label.
