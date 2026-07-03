---
"@originals/sdk": patch
---

Fix five correctness bugs surfaced by a fresh subsystem audit, each with regression coverage:

- **Ordinal-safe UTXO selection (sat-safety).** `selectResourceUtxos` / `selectUtxosForPayment` previously excluded only UTXOs flagged with the SDK-specific `hasResource` boolean, ignoring the `inscriptions[]` array that ordinals indexers populate as well as `locked` UTXOs. An inscription-bearing wallet UTXO with no `hasResource` flag could be chosen as a plain payment input, burning the ordinal it carries. Selection now excludes inscription-bearing (`inscriptions.length > 0`) and locked UTXOs, matching the sibling `bitcoin/utxo.ts` selector.
- **Canonical `did:btco` identifiers.** `validateSatoshiNumber` trims/normalizes before validating, so `' 42 '` and `'007'` passed while the DID was still built from the raw argument — producing an unresolvable `did:btco: 42 ` or a non-canonical `did:btco:007` that never matches the inscribed `did:btco:7`. A new `canonicalizeSatoshi()` is now used when building the DID in `createBtcoDidDocument` and the `DIDManager` keyless-fallback path.
- **Network-aware satoshi extraction on transfer.** `LifecycleManager.transferOwnership` fell back to `asset.id.split(':')[2]`, which is the network tag (`reg`/`sig`) for `did:btco:reg:<sat>` / `did:btco:sig:<sat>` rather than the satoshi, so a regtest/signet transfer without a migration record looked up the wrong ordinal. It now uses the network-aware `parseSatoshiIdentifier`.
- **Strict hex decoding.** `hexToBytes` accepted malformed hex (`'1g' → [0x01]`, `'aa1z' → [0xaa, 0x01]`) because the per-byte `parseInt` NaN check stops at the first invalid nibble. It now rejects any non-hex character.
- **Strict `statusListIndex` parsing.** `parseInt('5abc', 10) === 5`, so a malformed revocation index silently targeted the wrong status-list bit in `checkStatus` / `revoke` / `suspend` / `unsuspend`. A new `parseStatusListIndex()` fails closed on non-integer input.
