---
"@originals/sdk": minor
"@originals/landing": patch
---

Upgrade `didwebvh-ts` to 3.0.0. Its dependencies no longer include `glob`, so
`bun audit --prod` no longer reports GHSA-3g3m-2fjr-6pw4 through it.

didwebvh-ts 3 takes the complete DID document instead of assembling one from
options. `createDIDOriginal`, `updateDIDOriginal` and the `WebVHManager`
create, update, rotate and recover methods keep their options and build that
document with the 2.8.0 rules, so a new DID's genesis entry is unchanged.

Rejected inputs (these DIDs could not be verified by `@originals/vh` before):

- A did:webvh domain must be a fully qualified DNS name. `localhost[:port]`
  and other single-label hosts are rejected with `INVALID_DOMAIN`.
  didwebvh-ts 3 no longer mints such a DID, and `@originals/vh` never
  verified one.
- A verification method's `controller` must be a non-empty DID or omitted
  (the DID then controls it). An empty or blank `controller` is rejected with
  `WEBVH_VERIFICATION_METHOD_CONTROLLER_INVALID`; 2.8.0 published it verbatim.

Behaviour changes in written logs:

- An update that does not change witnesses omits the `witness` parameter, so
  the active witnesses stay in force. 2.8.0 wrote `witness: {}` on every
  update, which turned witnessing off.
- Moving a portable DID rewrites the controller of each verification method
  that names the old DID to the new DID. 2.8.0 left the old DID there.
- `DIDManager.resolveDID` reads didwebvh-ts 3's DID Resolution result and
  treats any `didResolutionMetadata.error` as unresolved, even when a document
  accompanies it.
