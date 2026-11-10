---
'@originals/sdk': minor
'@originals/vh': patch
---

Add `@originals/sdk/did`, a browser entry for DIDs that needs no bundler shims.

- It exports `createDIDOriginal`, `updateDIDOriginal`,
  `prepareDIDDataForSigning` and `verifyDIDSignature`, plus the identity
  shape originals.build mints:
  - `createWebvhIdentity` / `ensureWebvhIdentity`: `#key-0` is the identity
    and update key, `#key-1` the authorship key. It refuses an authorship key
    that is the update key (P5.11).
  - `identityFromLog`: keeps the genesis DID after a move (P5.14).
  - `createWebvhAlias`, `aliasFromLog`.
  - `localWebvhSigner`, `userPathSegment`, `aliasPathSegment`.
- A Vite app that imports only this entry, `@originals/sdk/originals` and
  `@originals/vh/*` builds with no shims and runs in Chromium. CI checks this
  with `verify:browser-bundle`. The root `@originals/sdk` still reaches
  `fs`, `path` and `fs/promises`.
- The did:webvh input rules (domain, paths, update keys) moved to
  `did/webvh-rules`. The modules they came from re-export them, so nothing
  changes for callers.
- `didwebvh-ts` is imported once, statically.
- `@originals/vh/fetch` loads `node:https` and `node:dns/promises` by a name
  bundlers do not follow. A browser bundle no longer warns that they were
  externalized; they still load only when `safeFetch`'s Node defaults run.
