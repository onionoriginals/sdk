---
"@originals/sdk": patch
---

Fix: `prepareBitcoinPublication` crashed with a bare, unwrapped third-party `Error` (not the documented `CelError` contract) when an asset's CEL `metadata` contained an ordinary integer &gt;= 2^32 — a value fully valid under the CEL 3 wire format, but unencodable by the `micro-ordinals` CBOR encoder used for Bitcoin inscription sizing (#673). `checkedContent` (`packages/sdk/src/v3/bitcoin.ts`) now catches that encoder failure and rethrows it as a structured `CelError` with code `ASSET_INSCRIPTION_METADATA`.
