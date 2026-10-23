---
'@originals/landing': minor
---

Publishing resumes after an interruption and is complete only once a stranger can verify it. The engine keeps a publication record (alias built, uploaded, complete) in the account's store, so a publication interrupted before its entry, after it, or during the uploads resumes after a browser restart under the same alias and checkpoint, with no second publish entry. `publish()` resolves only after a cookie-less reader verifies the exact hosted snapshot with every byte; otherwise it throws `PublicationNotVerifiedError`. Until then the Original isn't shown as published (`publication: "incomplete"`, layer `did:vh`) and edits wait (#976 B, G4, G5).
