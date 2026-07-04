---
"@originals/sdk": patch
---

Fix five issues from the full codebase review not covered by the critical/high pass:

- **cel**: `verifyEventLog` now requires the first event to be a `create` event, matching every state-derivation path (#295), and treats a `deactivate` event as terminal — a log with events after a `deactivate` no longer verifies (#257).
- **did**: `DIDManager.resolveDID` routes did:btco resolution through the configured `ordinalsProvider` (via the new `OrdinalsProviderResolverAdapter`); with neither a provider nor an explicit `bitcoinRpcUrl`, it throws a structured `ORD_PROVIDER_REQUIRED` error instead of silently querying `http://localhost:3000` (#266).
- **did**: did:btco tombstone detection scans only the marker line, so a "marker + JSON document" update whose JSON body merely contains 🔥 no longer permanently deactivates the DID (#269).
- **core**: the `OriginalsSDK` constructor honors `config.keyStore` (an explicit `keyStore` parameter still takes precedence), so key registration no longer silently fails with `KEYSTORE_REQUIRED` far from the misconfiguration (#277).
