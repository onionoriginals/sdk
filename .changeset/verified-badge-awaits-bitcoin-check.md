---
'@originals/landing': patch
---

**Explore's "Verified" badge no longer reads verified before the Bitcoin check has actually resolved (#767).**

`ExploreOriginal` published the fast local hash/log/cel checks into state as soon as they resolved, then appended the Bitcoin (`"btco"`) check separately once its own (potentially slow) network round-trip completed. Since the badge is computed as `checks.every((check) => check.ok)`, a migrated Original rendered a ✓ "Hosted history and primary file verified" badge for the entire duration of that Bitcoin lookup, even though the one claim the badge exists to prove had not been checked yet — and could subsequently resolve to failed.

The effect now accumulates the full check batch, including the Bitcoin check when applicable, and publishes it to state exactly once. This keeps the page in its existing "checking" pending state until every applicable check has actually run, so the badge is never shown ahead of the evidence for it.
