---
"@originals/auth": patch
---

**Fix (regression of #341/#356, identity-fork): `getOrCreateTurnkeySubOrg`'s sub-org lookup no longer treats a generic transport error as "no existing sub-org."** `isDefinitiveNotFound` previously fell through to `createSubOrganization` on gRPC code `5` (NOT_FOUND) **or** any lookup error whose message matched `/not[ _-]?found|does not exist/i`. That message-substring match also matched errors unrelated to Turnkey's own not-found response — a plain-text `404 Not Found` from a routing/proxy layer, for example — silently minting a duplicate sub-organization (the user's stable identity) for an email that already had one.

`isDefinitiveNotFound` now trusts only the strongly-typed `code === 5` evidence (still walking a wrapped `cause` chain). `@turnkey/http`'s `TurnkeyRequestError` always carries a numeric `code` parsed from Turnkey's own JSON error body, so a genuine not-found response is never missing it; an unrelated transport/routing failure throws a plain `Error` with no `code` and is now correctly rethrown instead of authorizing creation.
