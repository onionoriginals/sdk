---
'@originals/vh': minor
'@originals/sdk': minor
'@originals/code': patch
---

Scoped grants (originals-spec #66, `a2b5013`: P5.28, P5.29, P14.23). The
member names stay PROVISIONAL (P14.5, D4).

- `@originals/vh`: an editor grant's optional `scope`, never with
  `resource: false`. A scope-type registry with `paths` (P14.23 patterns:
  `checkPathPattern`, `matchPathPattern`) and `items` (`add`, `edit`,
  `remove`), checked over a media type's path or item view
  (`MediaTypeView`, `ScopeViews`, `checkScopeChange`). A view may read
  objects the version references and report missing ones. The defaults are
  the code tree's path view (`application/vnd.originals.code-tree+json`,
  reading only changed subtrees, digests over mode and content) and a
  reference item view (`application/vnd.originals.items+json`). An unknown
  type, a missing view or missing bytes is `SCOPE_UNCHECKED`, incomplete and
  unverifiable after the anchor; a change outside is `SCOPE_OUTSIDE`. The
  report adds `grants[].scope` and `scopeObjects`.
- `@originals/sdk`: verification reads the objects scope checks need from
  the store. Packages carry them, or list `{ kind: "object", digest }`
  missing items.
- `@originals/code`: path grants reuse the vh pattern matcher and code tree
  constants instead of a copy.
