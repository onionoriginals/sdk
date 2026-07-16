---
"@originals/sdk": minor
---

Per-event real-time chain-recoverability (#407 phase 3). Once an asset is on
did:btco, every authorship append now inscribes on the anchoring sat as it
happens: `addResourceVersion` inscribes the new event (content = the new media,
metadata = the event delta + the updated did:btco doc with a fresh `#cel` head),
and rotations continue to reinscribe. The sat's inscription chain IS the
always-current log — no point-in-time staleness. `resolveAssetFromSat` now WALKS
that chain: it enumerates the sat's inscriptions, orders them strictly by
confirmed block height (fail-closed on a missing height), concatenates each
inscription's events (a full `celLog` snapshot is a checkpoint; an `events` delta
extends it) into the full current log, reattaches each on-chain-anchored event's
bitcoin witness proof, and runs the SAME `verifyEventLog` gate as any log — so a
gap, a chain-inconsistent inscription, or tampered metadata fails closed.
`QuickNodeProvider`/`OrdHttpProvider` `getInscriptionById` now decode inscription
CBOR metadata (present-but-undecodable → clear fail-closed error). btco authorship
appends are now paid Bitcoin operations: each surfaces a `cel:inscribe-cost`
estimate, and a btco append with no ordinals provider degrades to a hosted append
with a `cel:append-inscribe-skipped` signal. Provenance is now real-time
recoverable from Bitcoin alone.
