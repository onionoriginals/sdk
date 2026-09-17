---
"@originals/cel": patch
---

**`verifyHistory`'s fold now attributes each `rotateKey` entry to the outgoing controller who actually signed it, not the incoming controller (#831).** `AssetState.controllers`' interval boundaries were off by one: the outgoing controller's `throughEntry` stopped one entry short of the rotation it signed, and the incoming controller's `fromEntry` began at that same rotation entry — claiming authorship of an entry the incoming controller never signed. Per `specs/originals-cel-v3-authority.md`, a rotation A → B "is signed by A"; the entry recording that rotation now falls inside A's interval, and B's interval starts at the entry after it. This only corrects the publicly exposed `controllers` audit/interval data — acceptance and authorization decisions, which check the signer against `state.controller` independently, were never affected.
