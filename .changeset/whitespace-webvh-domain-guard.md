---
"@originals/sdk": patch
---

**`createDIDOriginal` and `updateDIDOriginal` now reject a blank/whitespace-only `domain` with `WEBVH_DOMAIN_REQUIRED`, matching `DIDManager`'s existing guard** (#678).

`#531` made `DIDManager.createDIDWebVH`/`migrateToDIDWebVH` refuse to guess a did:webvh domain: an omitted or blank domain throws `WEBVH_DOMAIN_REQUIRED` rather than silently minting an unresolvable DID. The standalone `createDIDOriginal`/`updateDIDOriginal` helpers in `packages/sdk/src/did/identity-operations.ts` — also exported as static `OriginalsSDK.createDIDOriginal`/`updateDIDOriginal` on both the default (CEL 3) and previous-format SDKs — were a second, independent call path into `didwebvh-ts` that did not share that guard:

- `createDIDOriginal({ domain: "   " })` silently minted a permanent `did:webvh` with literal unencoded spaces embedded in its identifier instead of failing loudly.
- `updateDIDOriginal({ domain: "   " })` had the same defect on the move/rotation path.
- `updateDIDOriginal({ domain: "" })` silently swallowed the move as a no-op (didwebvh-ts's internal `options.address || options.domain` treats `""` as falsy) instead of erroring — the caller got a normal success result with the DID's location unchanged.

Both helpers now validate a supplied `domain` with the same `requireWebVHDomain` guard `DIDManager` uses (now exported from `did/DIDManager.js`), before any signing work. `HostedAssets.prepare()` (`packages/sdk/src/v3/hosted.ts`) had a sibling gap — its `!options.domain` check treated a whitespace-only domain as "explicit" and let it through to fail later, mid-mint, with the wrong error code (`CEL_DID` instead of `WEBVH_DOMAIN_REQUIRED`); it now rejects blank/whitespace domains up front with the correct code too.

An explicit, non-blank domain continues to work exactly as before on all three paths; `updateDIDOriginal` with `domain` omitted entirely still updates without requiring one.
