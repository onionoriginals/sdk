---
'@originals/host': minor
---

Make the per-user quotas of `createOriginalsStore` explicit.

- `ORIGINALS_STORE_DEFAULTS` exports the defaults. They are unchanged: 100
  recorded Originals and 25 MiB of hosted bytes per user.
- The store reports `limits` and `usage(subject)`.
- A refused write throws `StoreFullError`, whose message is still
  `STORE_FULL`. Its `details` name the quota (`maxOriginals` or
  `maxTotalBytes`), the limit, what is used and, for bytes, what was
  requested.
- The 507 `store_full` answers from the Originals routes and shared-host
  saves now carry those details. Before, they were a bare
  `{ error: "store_full" }`.
- A quota that is not a whole number of 0 or more is refused when the store
  is made.
- The README documents all of this.
