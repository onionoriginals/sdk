---
"@originals/sdk": patch
---

Fix `HostedAssets.prepare()` reporting `ASSET_WEB_STATE` instead of the documented `WEBVH_DOMAIN_REQUIRED` when a missing/blank domain coincides with an invalid asset state (#798).

The asset-state/local-drafts guard ran before the domain-blank guard, so publishing a deactivated asset or one with unsigned local resource drafts with no domain masked the missing domain as `ASSET_WEB_STATE`. The domain precondition is now checked first and unconditionally, matching `packages/sdk/V3.md` and `CLAUDE.md`'s "every hosted publication requires an explicit domain" contract. The single-cause cases (a valid domain on an invalid-state asset, or a missing domain on a valid-state asset) are unaffected.
