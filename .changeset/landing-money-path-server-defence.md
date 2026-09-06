---
'@originals/landing': patch
---

**Money path: the server now verifies what it used to take on trust from the browser (#493).**

`POST /api/btc/inscribe` classifies every declared funding outpoint for inscriptions itself and refuses to broadcast a commit that would spend an inscribed sat, or one it cannot classify — the fail-closed ordinal property no longer rests in the browser alone. It also asserts where the money goes: the commit's change output and the reveal's output must both pay `changeAddress`, and `changeAddress` must be the deposit address bound to the account.

`GET /api/btc/deposit` says when its ordinal check was partial: an address holding more outputs than one poll can classify now reports `ordinalCheck: 'partial'` with the count of unchecked outputs, instead of `'ok'` over a silently truncated set. The page explains why the explorer balance reads higher.

The deposit poll now sends a `contentBytes` hint sized from the media, metadata and CEL log that will actually be inscribed, so the quote no longer defaults to 8,000 bytes and under-funds a larger asset after the creator has already deposited.
