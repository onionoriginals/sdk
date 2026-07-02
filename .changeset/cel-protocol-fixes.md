---
"@originals/sdk": minor
---

Fix two critical CEL (Cryptographic Event Log) protocol bugs:

- **did:btco migrations now produce verifiable logs.** `BtcoCelManager.migrate` mutated the event `data` (splicing in `targetDid`/`txid`/`inscriptionId`) *after* the controller signature and Bitcoin witness proof were computed, so every btco log failed `verifyEventLog`. The migration data is now finalized before signing: `targetDid` is derived deterministically from the source DID, and `txid`/`inscriptionId` (which can't be known before inscription) are read from the Bitcoin witness proof rather than embedded in the signed data.
- **`verifyEventLog` now binds every event to the log's controller key.** Previously any key could append, rename, "migrate", or deactivate anyone's log and it verified as valid. Verification now establishes the authorized key set from the create event and rejects any subsequent event whose controller proof is signed by an unauthorized key. (A caller-supplied custom verifier still takes full responsibility for authorization.)

The `originals-cel migrate` CLI now warns that a temporary (non-controller) signing key produces a log that won't verify under the new controller binding, and points to `--wallet`.
