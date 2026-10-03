---
"@originals/auth": patch
---

**`TurnkeyDIDSigner`'s session-expiry detection no longer throws an unrelated `TypeError` and masks the real error for circular-shaped rejections** (#696).

`asExpiryError()` called `JSON.stringify(error)` with no guard, so any rejected Turnkey/network error containing a circular reference (a common shape for wrapped fetch errors or `cause` chains) made `JSON.stringify` itself throw — that unrelated `TypeError` propagated to the caller instead of the original error, silently defeating expiry detection. `sign()`/`signBytes()` now rely solely on `withTokenExpiration()` (which already guards its own error-text extraction) as the single expiry boundary, and `collectErrorText()` now captures a plain object's `.message` before attempting `JSON.stringify`, so a circular rejection's diagnostic text is never discarded.
