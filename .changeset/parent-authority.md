---
'@originals/vh': minor
'@originals/sdk': minor
---

Parent Originals: authority from a parent, pinned (originals-spec #66,
`a2b5013`: P5.24–P5.27). The member names stay PROVISIONAL (P14.5, D4).

- `@originals/vh`: an optional `asset.parent`, `{did, versionId}`, set at
  genesis. Every entry's pin is checked against the parent's log and never
  goes backwards or to another branch. An editor entry may rely on a grant in
  the parent's `editors` at its pin; one grant, direct or inherited, allows
  the whole change. `verifyOriginal` takes `parents` evidence. Without it a
  child is incomplete. The report adds `grants` (direct or inherited, with
  the parent version) and `parentAuthority`, and labels entries
  historically authorized only once the parent's latest state no longer
  grants them (P5.26). Inscribed child entries pin no older than the
  anchored parent's accepted head (P5.27). Builders take `parent`, `pin`
  and, for an editor, the `inherited` grant. `ORIGINALS_LIMITS.parents` is 8.
  The VH-Log engine's editor `lists` hook now receives the entry context.
- `@originals/sdk`: `create({ parent })` and `edit({ pin })`, which by
  default advances to the newest parent version held, with an editor's
  inherited grant found in the held parent log. Packages carry
  `parents/<sha256(did)>/did.jsonl` through the highest pin, with its
  signers, or list a `{ kind: "parent", did, versionId }` missing item.
  `load` and `import` verify against them.
