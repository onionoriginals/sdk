---
"@originals/sdk": patch
---

Sign the anchoring sat on the secondary btco writer (`BtcoCelManager.migrate` /
`cel migrate` → btco), completing the anchored-sat binding for every btco path
and closing the known follow-up (#397) from the Part A cutover. The migrate-to-btco
CEL event now uses a pin-sat-first inscribe: `bitcoinManager.inscribeData({ buildContent })`
pins the satoshi before the reveal, so the event body can sign
`data.to = did:btco:<network>:<sat>` and inscribe the asset's btco DID document
(whose `#cel` OriginalsCelAnchor commits to that event's chain digest and IS the
Bitcoin witness artifact, with the `did:cel` back-linked in `alsoKnownAs`). This
un-quarantines the `BtcoCelManager` btco verifiability path — logs it produces now
pass `verifyEventLog` instead of failing `UNBOUND_ANCHOR`.

Fails closed: the sat signed into `data.to`, the sat the inscription landed on, and
the sat the witness proof carries must all agree, or `migrate` throws rather than
emitting a mis-anchored log. The witness proof satoshi is normalised to a string
(the verifier only recognises string sats), and a `lockKey` is passed to
`inscribeData` so a concurrent inscription of the same asset is rejected before
broadcast rather than double-paying. The verifier and the production
`LifecycleManager.inscribeOnBitcoin` path are unchanged.
