---
"@originals/landing": patch
---

**Fix: the page clipped itself on phones, and the inscribe estimate quoted below its own numbers.**

*Horizontal overflow at phone widths.* At 375px the demo card rendered 457px of content inside its own 325px shell, and `.demo-shell`'s `overflow: hidden` sliced the right-hand end off every line in it — step copy, buttons, the resolved DID log, the event entries. At 320px the whole page also scrolled sideways by 44px.

One root cause in four places: a bare `1fr` grid track is `minmax(auto, 1fr)`, whose floor is the content's min-content width. Every desktop rule in this app already used `minmax(0, …)`; the mobile fallbacks were left as `1fr`, so a single unbreakable identifier set a floor no phone viewport could satisfy. `.demo-body`, `.example-shell`, `.footer-inner` and `.footer-columns` are fixed, the columns get `min-width: 0`, and the prose carrying raw `did:webvh`/`did:key` strings (`.cel-entry-summary`, `.cel-entry-proof`) now wraps. The footer was the page-scroll on its own: two 150px column floors plus a 40px gap demand 340px inside the 272px a 320px viewport leaves.

Three narrow-phone concessions under one `≤420px` block: the asset artwork stacks above the form instead of beside it (side by side left the title input 78px wide at 320px), the controls gutter drops 24px → 16px, and the event-log tab strip scrolls in one row rather than being clipped.

Verified by rendering at 320, 375 and 414, both idle and after Create → Publish: no horizontal page scroll and no clipped content at any width. `scripts/viewport.mjs` is that check, wired into `landing:ci` beside the existing smoke and TTI gates; it fails on the parent commit and passes on the fix.

*The inscribe cost line.* It rounded its own figures down — the estimator produces 4,055 sats at 1 sat/vB and 18,089 at 5, and the copy said "around 4,000" and "18,000", quoting a creator 55 and 89 sats under what they would actually be asked for. Now 4,100 and 18,100, and the tests assert the direction (never below the estimator, within one 100-sat step of it) instead of pinning the strings. The line also sat directly above a button labelled "Run the simulation", so it read as that button's price; it moves below the button and now says plainly that the simulation is free and the price is for inscribing for real. Dropping "quoted live when you sign in" also removes a promise mock builds could not keep, since `demoTier('off', …).real` is false for every visitor there.

No change to the estimator, the fee logic, or any figure it produces.
