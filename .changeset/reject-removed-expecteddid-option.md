---
"@originals/cel": patch
---

**`verifyHistory` and `resolveSat` now reject the removed `expectedDid` option instead of silently skipping the identity check** (#774).

`docs/MIGRATION_4.0.md`/`packages/sdk/V3.md` document that these CEL 3 functions accept only `expectedAssetId` and that the deprecated `expectedDid` option is removed. Because both functions read `options.expectedAssetId` with no runtime check for unrecognized properties, a caller that still passed `expectedDid` (e.g. carrying over the legacy `@originals/cel` `verifyEventLog` option name via plain JS or an `as any` cast) got no error and no identity check at all — `resolveSat` reported `accepted` and `verifyHistory` returned normally, exactly as if no identity had been requested.

- `verifyHistory` now throws a `CelError` with code `CEL_OPTION_REMOVED` when `options` carries an own `expectedDid` property, whether or not `expectedAssetId` is also supplied.
- `resolveSat` now returns `{ status: "invalid", reason: "expectedDid was removed; pass expectedAssetId instead" }` for the same condition, keeping its existing fail-closed result shape instead of throwing.
- Passing only the current `expectedAssetId` option is unaffected on both functions.
