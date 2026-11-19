---
'@originals/sdk': minor
---

Scoped grants are checked before anyone is asked to sign (P5.28, P5.29,
P5.24). `edit`, `prepareEdit`, `sign`, `cosign` and `finalizeDraft` find the
grant an editor entry relies on, as the verifier does (direct first, then
inherited at the pin), and check the resource change against its `paths` or
`items` scope with the draft's and the store's bytes.

- Outside the scope: refused as `SCOPE_OUTSIDE` (`outside-grant`), naming the
  paths or operations in `details.outside`; nothing is signed. Before, the
  entry was signed and then refused as `COMMIT_VERIFICATION_FAILED`
  (`invalid-evidence`).
- Not checkable (bytes not held, an unknown scope type, a media type with no
  view): refused as `SCOPE_UNCHECKED` (`incomplete-evidence`) unless
  `EditInput.uncheckedScope: "allow"`. A candidate signed that way carries
  `scope: { status: "unchecked" }` and is never committed or submitted by
  this SDK, which cannot verify it.
