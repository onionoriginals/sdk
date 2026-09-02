---
"@originals/landing": patch
---

**Show the funding transaction while an inscription is still finishing.**

Between broadcasting the commit and the reveal confirming, the page said the inscription would "finish shortly" and named the satoshi — and gave nothing else. No transaction id, no link, nowhere to look. At the one moment a creator has just spent real money, the step went quiet, which reads as nothing having happened.

The commit-only view now carries the **funding transaction id, linked to a block explorer**, the fee rate it paid, a line stating the inscription transaction is already signed and broadcasts on its own, and a link to Your Originals, which the surrounding copy already told people to check but never linked.

Every value shown was already in `DemoAssetState.inscription` — this was a display gap, not missing data. The explorer URL goes through the same helper as the completed view, so a simulated run still offers no link to a transaction that does not exist, and nothing here claims the inscription has landed.
