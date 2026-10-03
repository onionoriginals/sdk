---
"@originals/sdk": patch
---

Normalize corrupt retained Bitcoin reveal transactions to `ASSET_BITCOIN_PUBLICATION` CelErrors and invalid WebVH method histories to `ASSET_WEBVH_BINDING` CelErrors during hosted publication, resolution, and republishing. Preserve storage failure and parsing-limit contracts.
