---
"@originals/sdk": patch
---

`createOrdinalsProviderFromEnv` now fails fast when `USE_LIVE_ORD_PROVIDER=true`
but `ORD_PROVIDER_BASE_URL` is unset, blank, or left at the documentation
placeholder `https://ord.example.com/api`, throwing
`StructuredError('ORD_PROVIDER_BASE_URL_REQUIRED')` instead of silently building
a live provider aimed at a nonexistent host. Also corrects a stale signet
integration test to assert `OrdinalsClient.estimateFee` throws (its hardened
behavior) rather than returning a fabricated positive fee rate. Related cleanup
from #328.
