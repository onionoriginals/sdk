---
"@originals/cel": major
"@originals/sdk": major
---

Use `did:cel:<SCID>` as the public Originals history identifier. Keep the
placeholder-derived genesis SCID, signing, and event-link hashes unchanged.
Read existing `ni:` IDs in version-4 envelopes and signed migration/WebVH
bindings, normalizing the public ID without rewriting signed data. Version-3
envelopes retain their did-only contract. Envelope fields and versions do not
change, and removed legacy API names are not restored.
