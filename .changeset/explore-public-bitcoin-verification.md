---
'@originals/landing': patch
---

**Explore now independently re-verifies an Original's accepted Bitcoin publication from public inputs, with no session required (#527).**

`/explore/<did>` previously verified only the hosted resource bytes, the did:webvh log, and the CEL controller history — a real gap for any Original that had already migrated on-sat, since the site's own Bitcoin read path (`/api/btc/sat-snapshot/:sat`) was signed-in-only. A genuinely cold-start visitor could not confirm the one claim that matters most: that this Original is actually inscribed on Bitcoin.

The public catalogue now surfaces the sat (`PublishedOriginal.sat`) once an Original's signed history has migrated to `did:btco`. A new unauthenticated, independently rate-limited route (`GET /api/explore/sat-snapshot/:sat`) exposes read-only sat-snapshot access — never funding, signing or broadcast capability, and never the authenticated money-path proxy — bounded to a configured Bitcoin provider and satoshi-number validation. The Explore detail page uses it to run `sdk.lifecycle.resolveAssetFromSat` against a fresh provider snapshot in the visitor's own browser, then binds the accepted result to the SAME asset id and controller the CEL/WebVH checks already verified, so a resolvable-but-unrelated sat cannot read as proof of this Original. A fourth "btco" check (only present when the Original has actually migrated) joins the existing hash/log/cel checks, and the sat is shown in the public provenance panel.
