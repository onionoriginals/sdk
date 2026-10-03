---

---

Fix `specs/auth/server-api.md` documenting stale signatures/return shapes for `TurnkeyWebVHSigner`, `createTurnkeySigner`, and `verifyEmailAuth` that no longer match the actual `@originals/auth` v6 server implementation (#822). `server-api.md` was left out of scope by PR #790, which reconciled the sibling `client-api.md` for the same defect class.
