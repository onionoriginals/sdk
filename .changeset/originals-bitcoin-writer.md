---
'@originals/sdk': minor
---

Writing anchored Originals to Bitcoin (plan 011 PR 10; plan 012), in the new `@originals/sdk/originals/bitcoin` entry. `prepareEntryInscription` inscribes an Original's head entry on its anchoring sat through the sat inscription builder (the first funding UTXO must hold the sat, so only its holder can extend the Original); `submitPreparedInscriptionOnSat` and `resumeInscriptionOnSat` give durable submission and same-pair retries; `readAnchored` reads the sat back, so the published boundary is what Bitcoin shows, never pending intent. Verified end to end on Bitcoin Core 31.1 and ord 0.29.0 regtest.
