---
"@originals/cel": major
---

**BREAKING: the previous-format (pre-CEL-3) writer surface moved to `@originals/cel/legacy`.** `PeerCelManager`, `WebVHCelManager`, `BtcoCelManager`, `OriginalsCel` (which wraps all three and exposed the same `create`/`update`/`migrate` methods through one class), the event-log algorithms those managers delegate to (`createEventLog`, `appendEvent`, `updateEventLog`, `deactivateEventLog`, `verifyEventLog`, `witnessEvent`, the custody-fold helpers), the previous-format canonicalizer (`canonicalizeEvent` and its derivatives — not RFC 8785, see issue #599), and the previous-format signer helpers built on it (`celSignerFromKeyPair`, `createKeyStoreCelSigner`, `currentControllerVm`, `hexSha256ToDigestMultibase`) are no longer exported from the `@originals/cel` package root.

Issue #597: `OriginalsCel` wraps the three layer managers and exposes the exact same previous-format write path (`create`/`update`/`migrate`) that the managers do, so removing only the three manager names left a residual bypass. The lower-level algorithms and signer helpers had the same problem — a consumer could reconstruct the same previous-format writer out of "primitive" root exports even without the named managers or classes. All of it now lives behind one explicit subpath so a new consumer importing `@originals/cel` cannot reach a previous-format writer and mistake it for the canonical one.

Existing code that imported any of the above from `@originals/cel` must import from `@originals/cel/legacy` instead. Byte semantics are unchanged — this is an export-surface move, not a behavior change. New code should use `@originals/cel/v3` for new histories; none of this previous-format surface is the compatibility path for CEL 3 / SDK 3.0.
